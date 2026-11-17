"""基于 SQLite 业务记录的确定性票务计价。"""
from datetime import datetime

from opentelemetry import trace
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.application import seed
from app import config as legacy_settings

from app.adapters.outbound.postgres.models import FeeRuleRecord, FlightRecord, OrderRecord
from app.domain.pricing.price_review import PriceReview, review_confirmed_quote

_tracer = trace.get_tracer("air-ticket.pricing")


class PricingError(Exception):
    """携带稳定业务错误码的计价异常；数据缺失和不可办理不会退化为普通金额结果。"""
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _percentage(amount: int, pct: int) -> int:
    """按整数 half-up 规则计算百分比费用；避免浮点误差和银行家舍入。"""
    # 先加半个百分点单位再整除，实现正金额 half-up，而非银行家舍入。
    return (amount * pct + 50) // 100


def _departure(flight: FlightRecord) -> datetime:
    return datetime.fromisoformat(f"{flight.date}T{flight.dep_time}")


async def calculate(session: AsyncSession, order_id: str, action: str,
                    target_date: str | None = None, target_flight: str | None = None) -> dict:
    """计算指定订单的退改费用并记录链路；实际规则校验集中在内部实现，便于统一观测。"""
    with _tracer.start_as_current_span("pricing.calculate") as span:
        span.set_attribute("pricing.action", action)
        return await _calculate(session, order_id, action, target_date, target_flight)


async def _calculate(session: AsyncSession, order_id: str, action: str,
                     target_date: str | None = None, target_flight: str | None = None) -> dict:
    """基于订单、航班和费率表确定性计价；负数差价不退，非自愿退改免收费用和差价。"""
    order = await session.get(OrderRecord, order_id)
    if order is None:
        raise PricingError("ORDER_NOT_FOUND", f"订单不存在：{order_id}")
    if order.status != "ISSUED":
        raise PricingError("ORDER_NOT_ISSUED", f"订单状态为 {order.status}，不能办理退改")

    flight = await session.scalar(select(FlightRecord).where(
        FlightRecord.flight_no == order.flight_no, FlightRecord.date == order.date))
    if flight is None:
        raise PricingError("DATA_MISSING", "订单关联的航班信息不存在")
    rates = await session.scalar(select(FeeRuleRecord).where(
        FeeRuleRecord.airline == order.airline, FeeRuleRecord.fare_product == order.fare_product))
    if rates is None:
        raise PricingError("DATA_MISSING", f"缺少费率表：{order.airline} {order.fare_product}")

    now = legacy_settings.now()
    hours = (_departure(flight) - now).total_seconds() / 3600
    window = "after" if hours < 0 else "lt4" if hours < 4 else "h4" if hours < 48 else "h48" if hours < 168 else "d7"
    involuntary = ("GEN-CANCEL" if flight.status == "cancelled" else
                   "GEN-DELAY" if flight.status == "delayed" and flight.delay_min >= 120 else None)
    fare, tax = order.fare, order.tax
    base = {"order_id": order_id, "action": action, "currency": "CNY", "fare": fare, "tax": tax,
            "window": window, "window_label": seed.WINDOW_LABEL[window], "involuntary": bool(involuntary),
            "flight_status": flight.status, "delay_min": flight.delay_min, "allowed": True, "reason": "", "rate_pct": 0}
    fee_rates = rates.data

    if action == "CHANGE":
        if not target_date:
            raise PricingError("MISSING_TARGET_DATE", "改签必须提供目标日期")
        target = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == (target_flight or order.flight_no), FlightRecord.date == target_date))
        if (target is None or (target.origin, target.dest) != (flight.origin, flight.dest)
                or target.airline != order.airline):
            raise PricingError("NO_TARGET_FLIGHT", f"{target_date} 没有可改签的航班")
        if target.flight_no == order.flight_no and target_date == order.date:
            raise PricingError("SAME_FLIGHT", "改签目标与原航班相同")
        if target.status == "cancelled" or _departure(target) <= now:
            raise PricingError("TARGET_UNAVAILABLE", f"{target.flight_no} {target_date} 不可改签")
        if order.fare_product not in target.fares:
            raise PricingError("DATA_MISSING", f"目标航班缺少 {order.fare_product} 票价")
        target_info = {"flight_no": target.flight_no, "date": target_date, "dep_time": target.dep_time,
                       "fare": target.fares[order.fare_product]}
        if involuntary:
            return {**base, "target": target_info, "rule_id": involuntary, "change_fee": 0, "fare_diff": 0,
                    "total": 0, "reason": "非自愿改签，免改期费、免差价"}
        percentages = fee_rates["change"]
        rule_id = f"{order.airline}-{order.fare_product}-CHG"
        if percentages is None:
            return {**base, "target": target_info, "rule_id": rule_id, "allowed": False,
                    "reason": "该票价产品不得自愿改签"}
        pct = percentages[seed.WINDOWS.index(window)]
        change_fee = _percentage(fare, pct)
        fare_diff = max(0, target_info["fare"] - fare)
        return {**base, "target": target_info, "rule_id": rule_id, "rate_pct": pct,
                "change_fee": change_fee, "fare_diff": fare_diff, "total": change_fee + fare_diff}

    if action == "REFUND":
        rule_id = involuntary or f"{order.airline}-{order.fare_product}-RFD"
        if involuntary:
            return {**base, "rule_id": rule_id, "refund_fee": 0, "refund_amount": fare + tax,
                    "reason": "非自愿退票，全额退款"}
        percentages = fee_rates["refund"]
        if percentages is None:
            return {**base, "rule_id": rule_id, "allowed": False, "refund_fee": 0,
                    "refund_amount": 0, "reason": "该票价产品不得自愿退票"}
        pct = percentages[seed.WINDOWS.index(window)]
        refund_fee = _percentage(fare, pct)
        return {**base, "rule_id": rule_id, "rate_pct": pct, "refund_fee": refund_fee,
                "refund_amount": fare - refund_fee + tax}

    raise PricingError("BAD_ACTION", f"不支持的操作：{action}")


def review_price(confirmed_amount: int, current_amount: int) -> PriceReview:
    """复核当前金额能否沿用已确认金额；领域规则决定价格保护或重新报价。"""
    return review_confirmed_quote(confirmed_amount, current_amount)
