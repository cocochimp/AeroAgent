"""办理记录读取与结果对账。"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.adapters.inbound.http.auth import Principal, get_principal
from app.adapters.outbound.airline.factory import create_airline_gateway
from app.adapters.outbound.persistence.database import SessionFactory
from app.adapters.outbound.persistence.models import (
    AirlineReceiptRecord, AuditRecord, OperationRecord, QuoteRecord, ServiceCaseRecord,
)
from app.application.fulfillment import settle_operation
from app.application.ports.services import AirlineGateway

router = APIRouter(prefix="/api/v1", tags=["operations"])


def _gateway() -> AirlineGateway:
    """按配置返回 mock/http/cassette；接口语义保持一致。"""
    return create_airline_gateway()


async def _owned_operation(operation_id: str, user_id: str) -> tuple[OperationRecord, ServiceCaseRecord]:
    """读取当前用户自有办理记录；他人记录统一按不存在处理。"""
    async with SessionFactory() as session:
        operation = await session.get(OperationRecord, operation_id)
        if operation is None:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "办理记录不存在",
                                             "details": {}})
        case = await session.get(ServiceCaseRecord, operation.case_id)
        if case is None or case.user_id != user_id:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "办理记录不存在",
                                             "details": {}})
        return operation, case


@router.get("/operations/{operation_id}")
async def get_operation(operation_id: str, principal: Principal = Depends(get_principal)):
    """返回办理状态、航司回执与审计轨迹。"""
    async with SessionFactory() as session:
        operation = await session.get(OperationRecord, operation_id)
        if operation is None:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "办理记录不存在",
                                             "details": {}})
        case = await session.get(ServiceCaseRecord, operation.case_id)
        if case is None or case.user_id != principal.user_id:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "办理记录不存在",
                                             "details": {}})
        quote = await session.get(QuoteRecord, operation.quote_id)
        receipt = await session.get(AirlineReceiptRecord, operation.idempotency_key)
        audits = list(await session.scalars(select(AuditRecord).where(
            AuditRecord.resource_id == operation_id).order_by(AuditRecord.created_at)))
        return {"operation_id": operation.operation_id, "case_id": operation.case_id,
                "order_id": operation.order_id, "action": operation.action,
                "amount": operation.amount, "status": operation.status,
                "request": operation.request, "response": operation.response,
                "quote": ({"quote_id": quote.quote_id, "status": quote.status,
                           "amount": quote.amount, "details": quote.details} if quote else None),
                "receipt": receipt.receipt if receipt else None,
                "audit": [{"action": row.action, "actor_id": row.actor_id,
                           "payload": row.payload, "created_at": row.created_at} for row in audits],
                "created_at": operation.created_at, "updated_at": operation.updated_at}


@router.post("/operations/{operation_id}/reconcile")
async def reconcile_operation(operation_id: str, principal: Principal = Depends(get_principal)):
    """按幂等键向航司核对未知结果；查到回执后走统一结算，不重复出票。"""
    operation, _ = await _owned_operation(operation_id, principal.user_id)
    if operation.status != "RESULT_UNKNOWN":
        return {"operation_id": operation_id, "status": operation.status, "reconciled": False,
                "reason": "当前状态无需对账"}
    gateway = _gateway()
    found = await gateway.find_by_idempotency_key(operation.idempotency_key)
    if found is None or found.get("status") == "UNKNOWN":
        # 超时后回执可能缺失；用同一幂等键再查一次，避免把已成功办理永久挂在未知态。
        found = await gateway.submit({
            "idempotency_key": operation.idempotency_key,
            "order_id": operation.order_id,
            "action": operation.action,
            "amount": operation.amount,
            "pricing": (operation.request or {}).get("final_pricing", {}),
        })
    if found.get("status") not in {"ACCEPTED", "REJECTED"}:
        return {"operation_id": operation_id, "status": "RESULT_UNKNOWN", "reconciled": False,
                "reason": found.get("message") or "航司暂未返回结果，请稍后再试"}
    settled = await settle_operation(operation_id, found)
    return {"operation_id": operation_id, "reconciled": True, **settled}
