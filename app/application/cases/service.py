"""案件、报价和确认用例，协调 Agent 结果与可靠交易写入。"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone

from opentelemetry import trace
from sqlalchemy import select, update

from app.application.agents.main_agent import MainServiceAgent

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import (
    AuditRecord,
    CaseEventRecord,
    OperationRecord,
    OrderRecord,
    OutboxRecord,
    ProfileRecord,
    QuoteRecord,
    ServiceCaseRecord,
)
from app.adapters.outbound.redis.streams import Streams
from app.adapters.outbound.sqlite.runtime_projection import (persist_agent_profile, sync_agent_projection)
from app.application.pricing import PricingError, calculate
from app.domain.pricing.price_review import (
    PriceReviewStatus,
    refund_decrease_requires_confirmation,
    review_confirmed_quote,
)

_streams = Streams()
_main_agent = MainServiceAgent()
_tracer = trace.get_tracer("air-ticket.case")


def utcnow() -> datetime:
    """返回带时区的当前 UTC 时间；所有持久化记录使用同一时间基准。"""
    return datetime.now(timezone.utc)


_TRACE_KEYS = {"node", "status", "ms", "at", "note", "input", "output"}
_TRACE_VALUE_KEYS = {
    "order_id", "user_id", "flight_no", "date", "airline", "origin", "dest", "action", "intent",
    "scenario", "rule_id", "rule_ids", "rule_refs", "allowed", "amount", "total", "fee", "fee_items",
    "refund_fee", "change_fee", "fare_diff", "refund_amount", "tax", "fare", "fare_product", "cabin",
    "status", "delay_min", "sub_idx", "index", "target", "count", "score", "tokens", "budget",
    "truncated", "threshold", "confidence", "support_ratio", "retries", "k", "candidate_id", "stage",
}


def _safe_trace_value(value):
    if isinstance(value, dict):
        return {key: _safe_trace_value(item) for key, item in list(value.items())[:40]
                if key in _TRACE_VALUE_KEYS}
    if isinstance(value, (list, tuple)):
        return [_safe_trace_value(item) for item in value[:20]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:160]
    return None


def sanitize_trace_event(event: dict) -> dict:
    """提取单条 Agent 轨迹，只保留学习面板可安全展示的字段。"""
    source = event.get("event") if isinstance(event.get("event"), dict) else event
    return {key: (_safe_trace_value(value) if key in {"input", "output"} else value[:160] if key == "note" and isinstance(value, str) else value)
            for key, value in source.items() if key in _TRACE_KEYS}


def make_agent_event_callback(case_id: str, loop):
    """把同步 Agent 回调桥接为可持久化的异步案件事件。"""
    def on_event(event: dict) -> None:
        """把同步 Agent 回调桥接为持久化异步事件；等待写入完成，保证轨迹先于最终结果可见。"""
        event_type = event.get("type", "trace")
        if event_type == "trace":
            event_type, payload = "case.trace", sanitize_trace_event(event)
        else:
            event_type = "case.interrupt"
            raw = event.get("payload") or {}
            payload = {key: _safe_trace_value(value) for key, value in raw.items()
                       if key in {"kind", "order_id", "options", "fields"}}
        future = asyncio.run_coroutine_threadsafe(record_case_event(case_id, event_type, payload), loop)
        future.result(timeout=15)
    return on_event


async def record_case_event(case_id: str, event_type: str, payload: dict) -> None:
    """先持久化案件事件再发布到流；发布失败保留数据库记录，成功后回填 stream_id。"""
    now = utcnow()
    async with SessionFactory() as session:
        row = CaseEventRecord(case_id=case_id, event_type=event_type, payload=payload,
                              stream_id=None, created_at=now)
        session.add(row)
        await session.commit()
        event_id = row.id
    try:
        stream_id = await _streams.publish_case_event(case_id, event_type,
                                                      {"case_id": case_id, **payload})
    except Exception:
        return
    async with SessionFactory() as session:
        row = await session.get(CaseEventRecord, event_id)
        if row:
            row.stream_id = stream_id
            await session.commit()


async def run_case_turn(payload: dict) -> dict:
    """执行或恢复一轮 Agent 会话并持久化报价；异常标记结果未知，状态提交后逐条发布事件。"""
    case_id, user_id, session_id = payload["case_id"], payload["user_id"], payload["session_id"]
    async with SessionFactory() as projection_session:
        await sync_agent_projection(projection_session)
    await record_case_event(case_id, "case.started", {})
    loop = asyncio.get_running_loop()

    on_event = make_agent_event_callback(case_id, loop)

    with _tracer.start_as_current_span("servicing.case_turn") as span:
        span.set_attribute("servicing.case_id", case_id)
        span.set_attribute("servicing.resumed", payload.get("resume_payload") is not None)
        try:
            if payload.get("resume_payload") is not None:
                result = await asyncio.to_thread(_main_agent.resume, session_id, payload["resume_payload"],
                                                 on_event=on_event)
            else:
                result = await asyncio.to_thread(_main_agent.run_turn, session_id, user_id, payload["message"],
                                                 order_id=payload.get("order_id"), on_event=on_event)
        except Exception as exc:
            await record_case_event(case_id, "case.failed", {
                "error_type": type(exc).__name__, "message": "本轮处理未完成，已保留此前运行事件。"})
            async with SessionFactory() as failed_session:
                case = await failed_session.get(ServiceCaseRecord, case_id)
                if case:
                    case.status, case.updated_at = "RESULT_UNKNOWN", utcnow()
                    case.result = {"error": {"type": type(exc).__name__,
                                              "message": "本轮处理未完成，已保留此前运行事件。"}}
                    await failed_session.commit()
            raise
    async with SessionFactory() as profile_session:
        await persist_agent_profile(profile_session, user_id)
    result["trace"] = [sanitize_trace_event(event) for event in (result.get("trace") or [])]
    final = result.get("final") or {}
    raw_options = final.get("options") or []
    outputs = result.get("results") or []
    quote_rows = []
    expires_at = utcnow() + timedelta(minutes=10)
    resolved_order_id = payload.get("order_id") or (result.get("parsed") or {}).get("order_id")
    for index, option in enumerate(raw_options):
        if not option.get("allowed") or option.get("type") not in {"CHANGE", "REFUND"}:
            continue
        related = next((row for row in outputs if row.get("intent") == option["type"]), {})
        fee = related.get("fee") or {}
        amount = option.get("total")
        if amount is None:
            continue
        quote_id = f"q_{uuid.uuid4().hex}"
        rule_refs = option.get("rule_refs") or []
        detail = {"option_index": index, "title": option.get("title"), "fee_items": option.get("fee_items", []),
                  "rule_refs": rule_refs, "target": fee.get("target"), "pricing": fee}
        if not resolved_order_id:
            continue
        row = QuoteRecord(quote_id=quote_id, case_id=case_id, order_id=resolved_order_id,
                          action=option["type"], amount=amount, currency="CNY", details=[detail],
                          policy_version=":".join(rule_refs) or "engine-v1", benefit_version="benefit-v1",
                          status="OFFERED", expires_at=expires_at, created_at=utcnow())
        quote_rows.append((row, detail))
        option["quote_id"] = quote_id

    interrupt = result.get("interrupt")
    if interrupt and interrupt.get("kind") == "confirm":
        by_index = {row.details[0]["option_index"]: row for row, _ in quote_rows}
        for interrupt_option in interrupt.get("options", []):
            row = by_index.get(interrupt_option.get("index"))
            if row:
                interrupt_option["quote_id"] = row.quote_id

    status = ("WAITING_CONFIRMATION" if interrupt and interrupt.get("kind") == "confirm" else
              "NEEDS_INFORMATION" if interrupt else
              "HUMAN_REVIEW" if result.get("outcome") == "HUMAN" else "PROPOSED")
    async with SessionFactory() as session:
        case = await session.get(ServiceCaseRecord, case_id)
        if case:
            case.status = status
            case.updated_at = utcnow()
            case.result = result
            case.order_id = resolved_order_id or case.order_id
            if quote_rows:
                case.current_quote_id = quote_rows[0][0].quote_id
                session.add_all([row for row, _ in quote_rows])
        await session.commit()

    for row, detail in quote_rows:
        await record_case_event(case_id, "quote.offered", {"quote": {
            "quote_id": row.quote_id, "action": row.action, "amount": row.amount,
            "currency": row.currency, "expires_at": row.expires_at.isoformat(), **detail,
        }})
    await record_case_event(case_id, "case.proposed", {"status": status, "outcome": result.get("outcome")})
    return result


async def _replay_confirmed_operation(session, quote_id: str, confirmation_id: str) -> dict:
    """回读已确认报价的既有办理记录；同一确认号返回幂等结果，不同确认号拒绝。"""
    quote = await session.get(QuoteRecord, quote_id)
    if quote is None:
        raise LookupError("报价不存在")
    if quote.confirmation_id != confirmation_id:
        raise ValueError("该报价已由其他确认请求确认")
    operation = await session.scalar(select(OperationRecord)
                                     .where(OperationRecord.quote_id == quote_id)
                                     .order_by(OperationRecord.created_at).limit(1))
    if operation is None:
        raise LookupError("已确认报价缺少办理记录")
    return {"status": operation.status, "operation_id": operation.operation_id,
            "quote_id": quote_id, "amount": quote.amount, "idempotent": True}


async def create_confirmed_operation(quote_id: str, user_id: str, confirmation_id: str,
                                     idempotency_key: str) -> dict:
    """对已确认报价重新计价，仅在价格保护范围内创建并投递交易。"""
    async with SessionFactory() as session:
        quote = await session.get(QuoteRecord, quote_id, with_for_update=True)
        if quote is None:
            raise LookupError("报价不存在")
        case = await session.get(ServiceCaseRecord, quote.case_id)
        if case is None or case.user_id != user_id:
            raise PermissionError("报价不存在或无权确认")
        if quote.status in {"CONFIRMED", "EXECUTED"}:
            await record_case_event(case.case_id, "quote.confirmation_replayed",
                                    {"quote_id": quote_id, "confirmation_id": confirmation_id})
            return await _replay_confirmed_operation(session, quote_id, confirmation_id)
        if quote.status not in {"OFFERED", "REQUOTE_REQUIRED"}:
            raise ValueError("该报价已失效，请确认最新报价")
        existing = await session.scalar(select(OperationRecord).where(
            OperationRecord.idempotency_key == idempotency_key))
        if existing:
            if existing.quote_id != quote_id or existing.case_id != case.case_id:
                raise ValueError("幂等键已被其他报价使用")
            if existing.status != "REQUOTE_REQUIRED":
                await record_case_event(case.case_id, "operation.replayed", {
                    "quote_id": quote_id, "operation_id": existing.operation_id})
                return {"status": existing.status, "operation_id": existing.operation_id,
                        "amount": existing.amount, "idempotent": True}
        pricing = quote.details[0].get("pricing", {}) if quote.details else {}
        try:
            current = await calculate(session, quote.order_id, quote.action,
                                      (pricing.get("target") or {}).get("date"),
                                      (pricing.get("target") or {}).get("flight_no"))
        except PricingError as exc:
            raise ValueError(str(exc)) from exc
        if not current.get("allowed", True):
            raise ValueError(current.get("reason", "当前方案不可办理"))
        if quote.status == "REQUOTE_REQUIRED":
            return {"status": "REQUOTE_REQUIRED", "quote_id": quote_id, "amount": quote.amount,
                    "reason": "该报价已失效，请确认最新报价", "current_pricing": current}

        if quote.action == "REFUND":
            amount = current["refund_amount"]
            if refund_decrease_requires_confirmation(quote.amount, amount):
                quote.status = "REQUOTE_REQUIRED"
                case.status, case.updated_at = "WAITING_CONFIRMATION", utcnow()
                await session.commit()
                return {"status": "REQUOTE_REQUIRED", "quote_id": quote_id, "amount": amount,
                        "reason": "退款金额减少，需要重新确认", "current_pricing": current}
            customer_amount = amount
            platform_variance = 0
        else:
            amount = current["total"]
            review = review_confirmed_quote(quote.amount, amount)
            if review.status is PriceReviewStatus.REQUOTE_REQUIRED:
                quote.status = "REQUOTE_REQUIRED"
                case.status, case.updated_at = "WAITING_CONFIRMATION", utcnow()
                await session.commit()
                return {"status": "REQUOTE_REQUIRED", "quote_id": quote_id, "amount": amount,
                        "reason": review.reason, "current_pricing": current}
            if review.status is not PriceReviewStatus.PROCEED_AT_CONFIRMED:
                raise ValueError(review.reason)
            customer_amount, platform_variance = quote.amount, review.platform_variance

        now = utcnow()
        operation_id = f"op_{uuid.uuid4().hex}"
        operation = {"operation_id": operation_id, "idempotency_key": idempotency_key,
                     "case_id": quote.case_id, "quote_id": quote_id, "order_id": quote.order_id,
                     "action": quote.action, "amount": customer_amount, "status": "PENDING",
                     "request": {"customer_amount": customer_amount, "supplier_amount": amount,
                                 "platform_variance": platform_variance, "pricing": current},
                     "response": {}, "created_at": now, "updated_at": now}
        cas = await session.execute(update(QuoteRecord)
                                    .where(QuoteRecord.quote_id == quote_id,
                                           QuoteRecord.status == "OFFERED")
                                    .values(status="CONFIRMED", confirmed_at=now,
                                            confirmation_id=confirmation_id,
                                            current_amount_at_review=amount,
                                            platform_variance=platform_variance))
        if cas.rowcount != 1:
            await session.rollback()
            return await _replay_confirmed_operation(session, quote_id, confirmation_id)
        case.status = "PROCESSING"
        case.updated_at = now
        session.add(OperationRecord(**operation))
        from app.adapters.outbound.postgres.models import OutboxRecord
        session.add(OutboxRecord(event_id=f"evt_{uuid.uuid4().hex}", topic="fulfillment.submit",
                                 aggregate_id=operation_id, payload={"operation_id": operation_id,
                                 "idempotency_key": idempotency_key}, created_at=now))
        session.add(AuditRecord(audit_id=f"audit_confirm_{operation_id}", actor_id=user_id,
                                action="quote.confirm", resource_id=quote_id,
                                payload={"operation_id": operation_id, "confirmed_amount": quote.amount,
                                         "current_amount": amount, "platform_variance": platform_variance},
                                created_at=now))
        await session.commit()
        await record_case_event(case.case_id, "quote.confirmed", {"quote_id": quote_id,
                                "operation_id": operation_id, "amount": customer_amount})
        return {"status": "ACCEPTED", "operation_id": operation_id, "amount": customer_amount,
                "platform_variance": platform_variance, "idempotent": False}


async def create_requote(quote_id: str, current_pricing: dict) -> dict:
    """替换已失效的确认方案并重新开放案件，等待乘客明确同意。"""
    async with SessionFactory() as session:
        old = await session.get(QuoteRecord, quote_id, with_for_update=True)
        if old is None:
            raise LookupError("报价不存在")
        case = await session.get(ServiceCaseRecord, old.case_id, with_for_update=True)
        if case and case.current_quote_id and case.current_quote_id != old.quote_id:
            latest = await session.get(QuoteRecord, case.current_quote_id)
            if latest and latest.details and latest.details[0].get("replaces_quote_id") == old.quote_id:
                return {"status": "REQUOTE_REQUIRED", "previous_quote_id": quote_id,
                        "quote_id": latest.quote_id, "amount": latest.amount, "currency": latest.currency}
        now = utcnow()
        amount = current_pricing["total"] if old.action == "CHANGE" else current_pricing["refund_amount"]
        if old.action == "CHANGE":
            fee_items = [
                {"name": "改期费", "amount": current_pricing.get("change_fee", 0)},
                {"name": "票面差价", "amount": current_pricing.get("fare_diff", 0)},
            ]
        else:
            fee_items = [
                {"name": "退票费", "amount": current_pricing.get("refund_fee", 0)},
                {"name": "机场建设费退还", "amount": current_pricing.get("tax", 0)},
            ]
        detail = {"title": f"{old.action} 新报价", "replaces_quote_id": old.quote_id,
                  "fee_items": fee_items,
                  "rule_refs": [current_pricing.get("rule_id")], "target": current_pricing.get("target"),
                  "pricing": current_pricing}
        new_id = f"q_{uuid.uuid4().hex}"
        new_quote = QuoteRecord(quote_id=new_id, case_id=old.case_id, order_id=old.order_id,
                                action=old.action, amount=amount, currency=old.currency, details=[detail],
                                policy_version=old.policy_version, benefit_version=old.benefit_version,
                                status="OFFERED", expires_at=now + timedelta(minutes=10), created_at=now)
        old.status = "REQUOTE_REQUIRED"
        if case:
            case.status = "WAITING_CONFIRMATION"
            case.current_quote_id = new_id
            case.updated_at = now
            session.add(AuditRecord(audit_id=f"audit_requote_{new_id}", actor_id=case.user_id,
                                    action="quote.requote", resource_id=new_id,
                                    payload={"previous_quote_id": quote_id, "amount": amount,
                                             "reason": "复核金额变化，等待旅客再次确认"}, created_at=now))
        session.add(new_quote)
        await session.commit()
    await record_case_event(old.case_id, "quote.revised", {"quote": {
        "quote_id": new_id, "action": old.action, "amount": amount, "currency": old.currency,
        "expires_at": new_quote.expires_at.isoformat(), **detail,
    }})
    return {"status": "REQUOTE_REQUIRED", "previous_quote_id": quote_id, "quote_id": new_id,
            "amount": amount, "currency": old.currency}
