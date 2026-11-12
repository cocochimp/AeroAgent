"""Authenticated order and admin demo-data operations."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from backend.app.adapters.inbound.http.auth import Principal, get_principal, require_admin
from backend.app.adapters.outbound.postgres.database import SessionFactory
from backend.app.adapters.outbound.postgres.models import (AuditRecord, FlightRecord, OrderRecord, ProfileRecord)
from backend.app.adapters.outbound.legacy.runtime_projection import sync_agent_projection
from backend.app.adapters.outbound.postgres.seed import seed_demo_data
from backend.app.application.pricing import PricingError, calculate
from air_agent import settings as legacy_settings

router = APIRouter(prefix="/api/v1", tags=["orders"])


class DemoDataCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str = Field(pattern=r"^(set_flight_status|clear_profile|reset_demo_data)$")
    flight_no: str | None = None
    date: str | None = None
    status: str | None = Field(default=None, pattern=r"^(scheduled|delayed|cancelled)$")
    delay_min: int = Field(default=0, ge=0, le=10080)
    user_id: str | None = None


@router.get("/orders")
async def list_orders(principal: Principal = Depends(get_principal)):
    async with SessionFactory() as session:
        query = select(OrderRecord).order_by(OrderRecord.date, OrderRecord.order_id)
        if not principal.is_admin:
            query = query.where(OrderRecord.user_id == principal.user_id)
        rows = list(await session.scalars(query))
        out = []
        for order in rows:
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.flight_no == order.flight_no, FlightRecord.date == order.date))
            target_date = max(legacy_settings.now().date(), datetime.fromisoformat(order.date).date()) + timedelta(days=1)
            eligibility = {}
            for action, key in (("CHANGE", "change"), ("REFUND", "refund")):
                try:
                    pricing = await calculate(session, order.order_id, action,
                                              target_date.isoformat() if action == "CHANGE" else None)
                    eligibility[key] = {"allowed": pricing.get("allowed", True), "reason": pricing.get("reason", ""),
                                        "rule_id": pricing.get("rule_id"),
                                        "amount": pricing.get("total") if action == "CHANGE" else pricing.get("refund_amount")}
                except PricingError as exc:
                    eligibility[key] = {"allowed": False, "reason": str(exc)}
            out.append({"order_id": order.order_id, "user_id": order.user_id, "passenger": order.passenger,
                        "flight_no": order.flight_no, "date": order.date, "airline": order.airline,
                        "cabin": order.cabin, "fare_product": order.fare_product, "fare": order.fare,
                        "tax": order.tax, "status": order.status, "ticket_no": order.ticket_no,
                        "eligibility": eligibility,
                        "flight": ({"origin": flight.origin, "dest": flight.dest,
                                    "origin_city": flight.origin_city, "dest_city": flight.dest_city,
                                    "dep_time": flight.dep_time, "status": flight.status,
                                    "delay_min": flight.delay_min} if flight else None)})
        if not principal.is_admin:
            return {"orders": out}
        profiles = list(await session.scalars(select(ProfileRecord).order_by(ProfileRecord.user_id)))
        return {"orders": out, "users": [{"user_id": p.user_id, "name": p.name, "tier": p.tier}
                                           for p in profiles],
                "profiles": [{"user_id": p.user_id, "name": p.name, "tier": p.tier, "data": p.data}
                              for p in profiles]}


@router.post("/orders")
async def mutate_demo_data(request: DemoDataCommand, principal: Principal = Depends(require_admin)):
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
            await seed_demo_data(session, force=True)
            result = {"reset": True}
        session.add(AuditRecord(audit_id=f"audit_demo_{now.timestamp()}_{principal.user_id}",
                                actor_id=principal.user_id, action=f"demo.{request.action}",
                                resource_id=request.user_id or request.flight_no, payload=result, created_at=now))
        await session.commit()
        await sync_agent_projection(session)
    return {"action": request.action, "result": result}
