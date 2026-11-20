"""确定性票务计价，包含数据库订单与纯 SmartMock 候选报价。"""
from collections.abc import Mapping
from datetime import datetime

from opentelemetry import trace
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.application import seed
from app import config as legacy_settings

from app.adapters.outbound.persistence.models import FeeRuleRecord, FlightRecord, OrderRecord
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


MIN_FARE = 1
MAX_FARE = 100_000


def price_change_candidate(order: Mapping, original_flight: Mapping, candidate: Mapping,
                           rates: Mapping, now: datetime) -> dict:
    """独立计算一个已校验候选；原票规则决定改期费，目标票价只决定非负差价。

    此函数不读取画像、数据库或全局时钟。除 candidate_id 外，候选快照与原有
    CHANGE 计价遵守相同的订单状态、航司航线、起飞时间和非自愿规则。
    """
    if order.get("status") != "ISSUED":
        raise PricingError("ORDER_NOT_ISSUED", f"订单状态为 {order.get('status')}，不能办理退改")
    if not isinstance(rates, Mapping) or "change" not in rates:
        raise PricingError("DATA_MISSING", f"缺少费率表：{order.get('airline')} {order.get('fare_product')}")
    candidate_id = candidate.get("candidate_id")
    if not isinstance(candidate_id, str) or not candidate_id:
        raise PricingError("CANDIDATE_ID_REQUIRED", "SmartMock 候选缺少 candidate_id")
    if (candidate.get("origin"), candidate.get("dest")) != (
            original_flight.get("origin"), original_flight.get("dest")) or \
            candidate.get("airline") != order.get("airline"):
        raise PricingError("NO_TARGET_FLIGHT", f"{candidate.get('date')} 没有可改签的航班")
    if candidate.get("flight_no") == order.get("flight_no") and candidate.get("date") == order.get("date"):
        raise PricingError("SAME_FLIGHT", "改签目标与原航班相同")
    try:
        target_departure = datetime.fromisoformat(f"{candidate['date']}T{candidate['dep_time']}")
        original_departure = datetime.fromisoformat(
            f"{original_flight['date']}T{original_flight['dep_time']}")
    except (KeyError, TypeError, ValueError) as exc:
        raise PricingError("TARGET_UNAVAILABLE", "目标航班日期或时间无效") from exc
    if candidate.get("status") == "cancelled" or target_departure <= now:
        raise PricingError("TARGET_UNAVAILABLE", f"{candidate.get('flight_no')} {candidate.get('date')} 不可改签")

    fare_product = candidate.get("fare_product")
    cabin = candidate.get("cabin")
    if fare_product not in seed.PRODUCTS or seed.PRODUCTS[fare_product][0] != cabin:
        raise PricingError("INVALID_FARE_PRODUCT", "目标舱位与票价产品不匹配")
    fares = candidate.get("fares") or {}
    target_fare = fares.get(fare_product)
    if target_fare is None and candidate.get("fare_product") == fare_product:
        target_fare = candidate.get("fare")
    if type(target_fare) is not int or not MIN_FARE <= target_fare <= MAX_FARE:
        raise PricingError("DATA_MISSING", f"目标航班缺少有效的 {fare_product} 票价")

    hours = (original_departure - now).total_seconds() / 3600
    window = "after" if hours < 0 else "lt4" if hours < 4 else "h4" if hours < 48 else "h48" if hours < 168 else "d7"
    involuntary = ("GEN-CANCEL" if original_flight.get("status") == "cancelled" else
                   "GEN-DELAY" if original_flight.get("status") == "delayed" and
                   original_flight.get("delay_min", 0) >= 120 else None)
    fare, tax = order["fare"], order["tax"]
    target = {"flight_no": candidate["flight_no"], "date": candidate["date"],
              "dep_time": candidate["dep_time"], "airline": candidate["airline"],
              "origin": candidate["origin"], "dest": candidate["dest"], "cabin": cabin,
              "fare_product": fare_product, "fare": target_fare}
    base = {"order_id": order["order_id"], "candidate_id": candidate_id, "action": "CHANGE",
            "currency": "CNY", "fare": fare, "tax": tax, "window": window,
            "window_label": seed.WINDOW_LABEL[window], "involuntary": bool(involuntary),
            "flight_status": original_flight["status"], "delay_min": original_flight.get("delay_min", 0),
            "allowed": True, "reason": "", "rate_pct": 0, "target": target}
    if involuntary:
        return {**base, "rule_id": involuntary, "change_fee": 0, "fare_diff": 0, "total": 0,
                "reason": "非自愿改签，免改期费、免差价"}
    percentages = rates["change"]
    rule_id = f"{order['airline']}-{order['fare_product']}-CHG"
    if percentages is None:
        return {**base, "rule_id": rule_id, "allowed": False, "change_fee": 0, "fare_diff": 0,
                "total": 0, "reason": "该票价产品不得自愿改签"}
    pct = percentages[seed.WINDOWS.index(window)]
    change_fee = _percentage(fare, pct)
    fare_diff = max(0, target_fare - fare)
    return {**base, "rule_id": rule_id, "rate_pct": pct, "change_fee": change_fee,
            "fare_diff": fare_diff, "total": change_fee + fare_diff}


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
