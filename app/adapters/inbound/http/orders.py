"""需认证的订单查询和管理员演示数据操作。"""
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, delete, func, or_, select

from app.adapters.inbound.http.auth import Principal, get_principal, require_admin
from app.adapters.outbound.persistence.database import SessionFactory
from app.adapters.outbound.persistence.models import (
    AuditRecord, BookingAttemptRecord, FlightRecord, OrderRecord, PriceAlertRecord,
    PriceObservationRecord, PriceWatchRecord, ProfileRecord, ServiceCaseRecord,
)
from app.adapters.outbound.sqlite.runtime_projection import sync_agent_projection
from app.adapters.outbound.persistence.seed import seed_demo_data
from app.application.pricing import PricingError, calculate
from app import config as legacy_settings

router = APIRouter(prefix="/api/v1", tags=["orders"])


class DemoDataCommand(BaseModel):
    """约束管理员演示数据操作；不同动作所需字段在路由中继续校验。"""
    model_config = ConfigDict(extra="forbid")
    action: str = Field(pattern=r"^(set_flight_status|clear_profile|reset_demo_data)$")
    flight_no: str | None = None
    date: str | None = None
    status: str | None = Field(default=None, pattern=r"^(scheduled|delayed|cancelled)$")
    delay_min: int = Field(default=0, ge=0, le=10080)
    user_id: str | None = None


def _as_utc(value: datetime | None) -> datetime | None:
    """SQLite 不保存时区名；读取 naive UTC 字段时恢复明确的 UTC 语义。"""
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


@router.get("/orders")
async def list_orders(
    principal: Principal = Depends(get_principal),
    q: Annotated[str, Query(max_length=100)] = "",
    sort: Annotated[Literal["created_at", "departure"], Query()] = "created_at",
    order: Annotated[Literal["asc", "desc"], Query()] = "desc",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
):
    """按当前主体搜索订单；SQL 完成筛选、稳定排序和分页，默认最近创建优先。"""
    join_condition = and_(FlightRecord.flight_no == OrderRecord.flight_no,
                          FlightRecord.date == OrderRecord.date)
    filters = []
    if not principal.is_admin:
        filters.append(OrderRecord.user_id == principal.user_id)
    term = q.strip()
    if term:
        searchable = (OrderRecord.order_id, OrderRecord.user_id, OrderRecord.passenger,
                      OrderRecord.flight_no, OrderRecord.airline, OrderRecord.date,
                      OrderRecord.status, FlightRecord.origin, FlightRecord.dest,
                      FlightRecord.origin_city, FlightRecord.dest_city,
                      FlightRecord.origin + "-" + FlightRecord.dest)
        filters.append(or_(*(column.contains(term, autoescape=True) for column in searchable)))

    async with SessionFactory() as session:
        count_query = select(func.count(OrderRecord.order_id)).select_from(OrderRecord).outerjoin(
            FlightRecord, join_condition).where(*filters)
        count_result = await session.scalar(count_query)
        if isinstance(count_result, int):
            total = count_result
        else:
            # 兼容不支持聚合的轻量会话适配器；真实 SQLAlchemy 会话始终走上方 COUNT。
            total = len(list(await session.scalars(select(OrderRecord.order_id).select_from(OrderRecord)
                                                   .outerjoin(FlightRecord, join_condition).where(*filters))))
        sort_columns = ([OrderRecord.date, FlightRecord.dep_time, OrderRecord.order_id]
                        if sort == "departure" else [OrderRecord.created_at, OrderRecord.order_id])
        if order == "desc":
            sort_columns = [column.desc() for column in sort_columns]
        query = (select(OrderRecord).outerjoin(FlightRecord, join_condition).where(*filters)
                 .order_by(*sort_columns).limit(page_size).offset((page - 1) * page_size))
        rows = list(await session.scalars(query))
        out = [await _order_payload(session, item) for item in rows]
        result = {"orders": out, "q": term, "sort": sort, "order": order, "page": page,
                  "page_size": page_size, "total": total,
                  "total_pages": (total + page_size - 1) // page_size}
        if not principal.is_admin:
            return result
        profiles = list(await session.scalars(select(ProfileRecord).order_by(ProfileRecord.user_id)))
        return {**result, "users": [{"user_id": p.user_id, "name": p.name, "tier": p.tier}
                                    for p in profiles],
                "profiles": [{"user_id": p.user_id, "name": p.name, "tier": p.tier, "data": p.data}
                              for p in profiles]}



async def _order_payload(session, item: OrderRecord, *, include_cases: bool = False) -> dict:
    """序列化订单、退改资格和可选关联案件；列表与详情共用同一口径。"""
    flight = await session.scalar(select(FlightRecord).where(
        FlightRecord.flight_no == item.flight_no, FlightRecord.date == item.date))
    target_date = max(legacy_settings.now().date(),
                      datetime.fromisoformat(item.date).date()) + timedelta(days=1)
    eligibility = {}
    for action, key in (("CHANGE", "change"), ("REFUND", "refund")):
        if item.status == "PENDING_PAYMENT":
            eligibility[key] = {"allowed": False, "reason": "ORDER_NOT_ISSUED", "rule_id": None,
                                "amount": None}
            continue
        try:
            pricing = await calculate(session, item.order_id, action,
                                      target_date.isoformat() if action == "CHANGE" else None)
            eligibility[key] = {"allowed": pricing.get("allowed", True), "reason": pricing.get("reason", ""),
                                "rule_id": pricing.get("rule_id"),
                                "amount": pricing.get("total") if action == "CHANGE" else pricing.get("refund_amount")}
        except PricingError as exc:
            eligibility[key] = {"allowed": False, "reason": str(exc)}
    payload = {"order_id": item.order_id, "user_id": item.user_id, "passenger": item.passenger,
               "flight_no": item.flight_no, "date": item.date, "airline": item.airline,
               "cabin": item.cabin, "fare_product": item.fare_product, "fare": item.fare,
               "tax": item.tax, "currency": getattr(item, "currency", "CNY"),
               "status": item.status, "ticket_no": item.ticket_no,
               "created_at": _as_utc(getattr(item, "created_at", None)),
               "updated_at": _as_utc(getattr(item, "updated_at", None)),
               "paid_at": _as_utc(getattr(item, "paid_at", None)),
               "eligibility": eligibility,
               "flight": ({"origin": flight.origin, "dest": flight.dest,
                           "origin_city": flight.origin_city, "dest_city": flight.dest_city,
                           "dep_time": flight.dep_time, "status": flight.status,
                           "delay_min": flight.delay_min} if flight else None)}
    if include_cases:
        cases = list(await session.scalars(select(ServiceCaseRecord).where(
            ServiceCaseRecord.order_id == item.order_id).order_by(
            ServiceCaseRecord.created_at.desc()).limit(10)))
        payload["cases"] = [{"case_id": case.case_id, "status": case.status,
                             "intent": case.intent, "created_at": _as_utc(case.created_at),
                             "updated_at": _as_utc(case.updated_at)} for case in cases]
    return payload


@router.get("/orders/{order_id}")
async def get_order(order_id: str, principal: Principal = Depends(get_principal)):
    """读取自有订单详情；他人订单统一按不存在处理。"""
    async with SessionFactory() as session:
        item = await session.get(OrderRecord, order_id)
        if item is None or (not principal.is_admin and item.user_id != principal.user_id):
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "订单不存在",
                                             "details": {}})
        return await _order_payload(session, item, include_cases=True)

@router.get("/orders/{order_id}/change-options")
async def list_change_options(order_id: str, principal: Principal = Depends(get_principal),
                              date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")):
    """返回同航司同航线的多方案改签；每个候选独立定价，不创建案件或报价。"""
    from app.application.change_options import build_change_options
    from app.application.pricing import PricingError
    from app.application.smart_mock import CandidateValidationError
    async with SessionFactory() as session:
        item = await session.get(OrderRecord, order_id)
        if item is None or (not principal.is_admin and item.user_id != principal.user_id):
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "订单不存在", "details": {}})
        try:
            return await build_change_options(session, item, date)
        except (CandidateValidationError, PricingError) as exc:
            code = getattr(exc, "code", "CANDIDATE_INVALID")
            raise HTTPException(409, detail={"code": code, "message": str(exc),
                                             "details": getattr(exc, "details", {})}) from exc


@router.post("/orders")
async def mutate_demo_data(request: DemoDataCommand, principal: Principal = Depends(require_admin)):
    """修改航班、清空画像或重置演示数据；写审计后同步 Agent 只读投影。"""
    now = datetime.now(timezone.utc)
    async with SessionFactory() as session:
        if request.action == "set_flight_status":
            if not request.flight_no or not request.date or not request.status:
                raise HTTPException(422, "设置航班状态需提供 flight_no、date、status")
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.flight_no == request.flight_no, FlightRecord.date == request.date))
            if flight is None:
                raise HTTPException(404, "航班不存在")
            flight.status = request.status
            flight.delay_min = request.delay_min if request.status == "delayed" else 0
            result = {"flight_no": flight.flight_no, "date": flight.date, "status": flight.status,
                      "delay_min": flight.delay_min}
        elif request.action == "clear_profile":
            if not request.user_id:
                raise HTTPException(422, "清理画像需提供 user_id")
            profile = await session.get(ProfileRecord, request.user_id)
            if profile is None:
                raise HTTPException(404, "用户画像不存在")
            profile.data = {}
            result = {"user_id": profile.user_id, "cleared": True}
        else:
            # 共享 seeder 不认识本资源的新表；先清子表，避免外键阻塞或遗留孤儿记录。
            for model in (PriceAlertRecord, PriceObservationRecord, PriceWatchRecord,
                          BookingAttemptRecord):
                await session.execute(delete(model))
            await seed_demo_data(session, force=True)
            result = {"reset": True}
        session.add(AuditRecord(audit_id=f"audit_demo_{now.timestamp()}_{principal.user_id}",
                                actor_id=principal.user_id, action=f"demo.{request.action}",
                                resource_id=request.user_id or request.flight_no, payload=result, created_at=now))
        await session.commit()
        await sync_agent_projection(session)
    return {"action": request.action, "result": result}
