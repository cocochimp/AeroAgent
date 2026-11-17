"""已确认写侧履约与账本入账，覆盖价格复核和未知结果。"""
import hashlib
from datetime import timezone

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import (
    AuditRecord,
    FlightRecord,
    LedgerRecord,
    OperationRecord,
    OrderRecord,
    QuoteRecord,
    ServiceCaseRecord,
)
from app.application.cases.service import create_requote, record_case_event, utcnow
from app.application.ports.services import AirlineGateway
from app.application.pricing import PricingError, calculate
from app.domain.pricing.price_review import review_confirmed_quote, refund_decrease_requires_confirmation


def _ticket_no(idempotency_key: str, flight_no: str) -> str:
    """由幂等键和目标航班确定性生成票号；重复办理同一操作不会产生新票号。"""
    digest = hashlib.sha256(f"{idempotency_key}:{flight_no}".encode()).hexdigest()
    return f"781-{int(digest[:16], 16) % 10**10:010d}"


async def fulfill_operation(operation_id: str, airline: AirlineGateway) -> dict:
    """提交航司前复核价格并持久化唯一结果；超时标记结果未知，避免盲目重试造成重复出票。"""
    requote: tuple[str, dict] | None = None
    async with SessionFactory() as session:
        operation = await session.get(OperationRecord, operation_id, with_for_update=True)
        if operation is None:
            raise LookupError(f"办理记录不存在：{operation_id}")
        if operation.status in {"SUCCEEDED", "FAILED", "REQUOTE_REQUIRED"}:
            return {"operation_id": operation_id, "status": operation.status, "idempotent": True}
        quote = await session.get(QuoteRecord, operation.quote_id, with_for_update=True)
        order = await session.get(OrderRecord, operation.order_id, with_for_update=True)
        if quote is None or order is None:
            operation.status = "FAILED"
            operation.response = {"reason": "报价或订单记录不存在"}
            operation.updated_at = utcnow()
            await session.commit()
            return {"operation_id": operation_id, "status": operation.status}
        if not quote.confirmed_at or not quote.confirmation_id:
            operation.status = "FAILED"
            operation.response = {"reason": "报价尚未获得旅客确认"}
            operation.updated_at = utcnow()
            await session.commit()
            return {"operation_id": operation_id, "status": "FAILED"}
        target = (quote.details[0].get("pricing", {}).get("target") or {}) if quote.details else {}
        try:
            current = await calculate(session, quote.order_id, quote.action, target.get("date"), target.get("flight_no"))
        except PricingError as exc:
            operation.status = "FAILED"
            operation.response = {"reason": str(exc), "code": exc.code}
            operation.updated_at = utcnow()
            case = await session.get(ServiceCaseRecord, quote.case_id)
            if case:
                case.status, case.updated_at = "HUMAN_REVIEW", utcnow()
            await session.commit()
            await record_case_event(quote.case_id, "fulfillment.rejected", operation.response)
            return {"operation_id": operation_id, "status": "FAILED", "reason": str(exc)}

        if quote.action == "REFUND":
            changed = refund_decrease_requires_confirmation(quote.amount, current["refund_amount"])
            variance = 0
            customer_amount = current["refund_amount"]
        else:
            review = review_confirmed_quote(quote.amount, current["total"])
            changed = review.status.value != "PROCEED_AT_CONFIRMED"
            variance = review.platform_variance
            customer_amount = quote.amount
        if changed:
            operation.status = "REQUOTE_REQUIRED"
            operation.response = {"reason": "价格复核超出已确认方案", "current_pricing": current}
            operation.updated_at = utcnow()
            await session.commit()
            requote = (quote.quote_id, current)
        else:
            # 先持久化 SUBMITTED 和幂等键再调用外部网关，崩溃后可按同一键核对或重放。
            operation.status = "SUBMITTED"
            operation.request = {**operation.request, "final_pricing": current,
                                 "customer_amount": customer_amount, "platform_variance": variance}
            operation.updated_at = utcnow()
            await session.commit()

    if requote:
        result = await create_requote(*requote)
        async with SessionFactory() as session:
            op = await session.get(OperationRecord, operation_id)
            if op:
                op.response = {**op.response, "replacement_quote_id": result["quote_id"]}
                await session.commit()
        return {"operation_id": operation_id, **result}

    try:
        supplier_result = await airline.submit({"idempotency_key": operation.idempotency_key,
                                                "order_id": operation.order_id, "action": operation.action,
                                                "amount": current.get("total", current.get("refund_amount")),
                                                "pricing": current})
    except TimeoutError as exc:
        # 超时不等于航司未出票，只能进入待核对状态，禁止按明确失败自动重试。
        supplier_result = {"status": "TIMEOUT", "code": "SUPPLIER_TIMEOUT",
                           "message": str(exc) or "航司响应超时，办理结果待核对", "retryable": True}

    if supplier_result.get("status") != "ACCEPTED":
        async with SessionFactory() as session:
            operation = await session.get(OperationRecord, operation_id, with_for_update=True)
            quote = await session.get(QuoteRecord, operation.quote_id, with_for_update=True)
            now = utcnow()
            rejected = supplier_result.get("status") == "REJECTED"
            operation.status = "FAILED" if rejected else "RESULT_UNKNOWN"
            operation.response = supplier_result
            operation.updated_at = now
            case = await session.get(ServiceCaseRecord, quote.case_id, with_for_update=True)
            if case:
                case.status = "HUMAN_REVIEW" if rejected else "RESULT_UNKNOWN"
                case.updated_at = now
                case.result = {**case.result, "operation": supplier_result}
            await session.commit()
        event_type = "fulfillment.rejected" if rejected else "fulfillment.result_unknown"
        await record_case_event(quote.case_id, event_type, {"operation_id": operation_id, **supplier_result})
        return {"operation_id": operation_id, **supplier_result, "status": operation.status}

    async with SessionFactory() as session:
        operation = await session.get(OperationRecord, operation_id, with_for_update=True)
        if operation.status == "SUCCEEDED":
            return {"operation_id": operation_id, **operation.response, "idempotent": True}
        quote = await session.get(QuoteRecord, operation.quote_id, with_for_update=True)
        order = await session.get(OrderRecord, operation.order_id, with_for_update=True)
        now = utcnow()
        current = operation.request["final_pricing"]
        customer_amount = operation.request["customer_amount"]
        variance = operation.request["platform_variance"]
        if quote.action == "CHANGE":
            target = current["target"]
            ticket_no = _ticket_no(operation.idempotency_key, target["flight_no"])
            order.flight_no, order.date = target["flight_no"], target["date"]
            order.fare, order.status, order.ticket_no = max(order.fare, target["fare"]), "CHANGED", ticket_no
            airline_amount = -current["total"]
            customer_posting = customer_amount
            platform_posting = variance
            result = {"status": "CHANGED", "ticket_no": ticket_no, "target": target,
                      "customer_amount": customer_amount, "platform_variance": variance}
        else:
            order.status = "REFUNDED"
            ticket_no = order.ticket_no
            airline_amount = customer_amount
            customer_posting = -customer_amount
            platform_posting = 0
            result = {"status": "REFUNDED", "ticket_no": ticket_no,
                      "customer_amount": customer_amount, "platform_variance": 0}
        if customer_posting:
            session.add(LedgerRecord(entry_id=f"led_{operation_id}_customer", operation_id=operation_id,
                                     account="CUSTOMER", amount=customer_posting, currency="CNY",
                                     reason="乘客改签支付" if quote.action == "CHANGE" else "退票退款",
                                     created_at=now))
        if airline_amount:
            session.add(LedgerRecord(entry_id=f"led_{operation_id}_airline", operation_id=operation_id,
                                     account="AIRLINE", amount=airline_amount, currency="CNY",
                                     reason="航司办理金额", created_at=now))
        if platform_posting:
            session.add(LedgerRecord(entry_id=f"led_{operation_id}_platform", operation_id=operation_id,
                                     account="PLATFORM", amount=platform_posting, currency="CNY",
                                     reason="确认后 1% 价格保护差额", created_at=now))
        # 订单、账本、操作、报价与审计共享最终事务，任一步失败都不留下部分成功状态。
        operation.status, operation.response, operation.updated_at = "SUCCEEDED", {**result, **supplier_result}, now
        quote.status, quote.current_amount_at_review, quote.platform_variance = "EXECUTED", current.get("total", current.get("refund_amount")), variance
        case = await session.get(ServiceCaseRecord, quote.case_id, with_for_update=True)
        if case:
            case.status, case.updated_at = "COMPLETED", now
            case.result = {**case.result, "operation": result}
        session.add(AuditRecord(audit_id=f"audit_{operation_id}", actor_id=case.user_id if case else operation.order_id,
                                action="fulfillment.complete", resource_id=operation_id,
                                payload={"quote_id": quote.quote_id, "status": operation.status}, created_at=now))
        await session.commit()
    await record_case_event(quote.case_id, "fulfillment.completed", {"operation_id": operation_id, **result})
    return {"operation_id": operation_id, **result}
