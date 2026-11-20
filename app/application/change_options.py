"""多方案改签：从同航司同航线快照生成 2–5 个候选，独立定价后排序。"""
from datetime import date as date_type, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import config as settings
from app.adapters.outbound.persistence.models import FeeRuleRecord, FlightRecord, OrderRecord, ProfileRecord
from app.application import smart_mock


def _order_map(order: OrderRecord) -> dict:
    return {"order_id": order.order_id, "user_id": order.user_id, "status": order.status,
            "airline": order.airline, "flight_no": order.flight_no, "date": order.date,
            "cabin": order.cabin, "fare_product": order.fare_product,
            "fare": order.fare, "tax": order.tax}


def _flight_map(flight: FlightRecord) -> dict:
    return {"flight_no": flight.flight_no, "date": flight.date, "airline": flight.airline,
            "origin": flight.origin, "dest": flight.dest, "origin_city": flight.origin_city,
            "dest_city": flight.dest_city, "dep_time": flight.dep_time,
            "duration_min": flight.duration_min, "status": flight.status,
            "delay_min": flight.delay_min, "fares": dict(flight.fares or {})}


async def build_change_options(session: AsyncSession, order: OrderRecord,
                               target_date: str | None = None, limit: int = 5) -> dict:
    """生成候选并独立报价；候选不足 2 个时明确返回不可用，不伪造方案。"""
    if order.status != "ISSUED":
        return {"order_id": order.order_id, "options": [], "reason": "ORDER_NOT_ISSUED"}
    original = await session.scalar(select(FlightRecord).where(
        FlightRecord.flight_no == order.flight_no, FlightRecord.date == order.date))
    if original is None:
        return {"order_id": order.order_id, "options": [], "reason": "FLIGHT_NOT_FOUND"}
    rates = await session.scalar(select(FeeRuleRecord).where(
        FeeRuleRecord.airline == order.airline, FeeRuleRecord.fare_product == order.fare_product))
    if rates is None:
        return {"order_id": order.order_id, "options": [], "reason": "FEE_RULE_NOT_FOUND"}

    now = settings.now()
    start = (date_type.fromisoformat(target_date) if target_date
             else max(now.date(), date_type.fromisoformat(order.date)) + timedelta(days=1))
    dates = [(start + timedelta(days=offset)).isoformat() for offset in range(max(4, limit))]
    flights = list(await session.scalars(select(FlightRecord).where(
        FlightRecord.airline == order.airline,
        FlightRecord.origin == original.origin, FlightRecord.dest == original.dest,
        FlightRecord.date.in_(dates), FlightRecord.status != "cancelled").order_by(
        FlightRecord.date, FlightRecord.dep_time)))
    proposals = []
    for flight in flights:
        fares = dict(flight.fares or {})
        # 只在订单原票价产品可售时给候选，保证“报价能办理”与确认时的计价口径一致。
        product = order.fare_product
        fare = fares.get(product)
        if not isinstance(fare, int):
            continue
        proposal = _flight_map(flight)
        proposal.pop("fares", None)
        proposals.append({**proposal, "cabin": order.cabin, "fare_product": product, "fare": fare})
        if len(proposals) >= limit:
            break
    if len(proposals) < 2:
        return {"order_id": order.order_id, "options": [], "reason": "NO_ALTERNATIVES"}
    profile_row = await session.get(ProfileRecord, order.user_id)
    profile = {"user_id": profile_row.user_id, "name": profile_row.name,
               "tier": profile_row.tier, "data": profile_row.data} if profile_row else None
    options = smart_mock.generate_change_options(_order_map(order), _flight_map(original),
                                                 proposals, rates.data, now, profile)
    return {"order_id": order.order_id, "target_date": start.isoformat(),
            "options": options, "reason": ""}
