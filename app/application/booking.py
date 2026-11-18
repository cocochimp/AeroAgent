"""本地 SQL 快照预订与幂等 Mock Payment；不调用真实航司、库存或资金渠道。"""
import hashlib
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import (
    AuditRecord,
    BookingAttemptRecord,
    FlightRecord,
    OrderRecord,
    utcnow,
)
from app import config as S
from app.adapters.outbound.sqlite.runtime_projection import sync_agent_projection
from app.application.seed import PRODUCTS, TAX


class BookingError(Exception):
    """可映射为版本化 HTTP 错误的预订业务异常。"""

    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _as_utc(value: datetime | None) -> datetime | None:
    """为 SQLite 读出的 naive UTC 时间恢复时区标记。"""
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _ticket_no(booking_id: str, payment_key: str) -> str:
    """用持久化预订和支付幂等键确定票号；重放不会生成新票号。"""
    digest = hashlib.sha256(f"{booking_id}:{payment_key}".encode()).hexdigest()
    return f"781-{int(digest[:16], 16) % 10**10:010d}"


def _booking_out(order: OrderRecord, attempt: BookingAttemptRecord, *, idempotent: bool = False) -> dict:
    """返回 UI 所需订单、快照及明确的模拟支付语义。"""
    payment = None
    if order.status == "ISSUED" and attempt.payment_idempotency_key:
        payment = {"provider": "mock", "status": "SUCCEEDED",
                   "idempotency_key": attempt.payment_idempotency_key, "real_funds": False}
    return {"booking_id": attempt.booking_id, "order_id": order.order_id, "user_id": order.user_id,
            "passenger": order.passenger, "flight_no": order.flight_no, "date": order.date,
            "airline": order.airline, "cabin": order.cabin, "fare_product": order.fare_product,
            "fare": order.fare, "tax": order.tax, "total": order.fare + order.tax,
            "currency": order.currency, "status": order.status, "ticket_no": order.ticket_no,
            "created_at": _as_utc(order.created_at), "updated_at": _as_utc(order.updated_at),
            "paid_at": _as_utc(order.paid_at), "payment": payment, "idempotent": idempotent,
            "inventory_source": "local_sql_snapshot"}


async def _owned_booking(session, booking_id: str, user_id: str, *, for_update: bool = False):
    """按当前主体读取预订和订单；他人资源统一按不存在处理。"""
    attempt = await session.get(BookingAttemptRecord, booking_id, with_for_update=for_update)
    if attempt is None or attempt.user_id != user_id:
        raise BookingError("BOOKING_NOT_FOUND", "预订不存在或不属于当前用户", 404)
    order = await session.get(OrderRecord, attempt.order_id, with_for_update=for_update)
    if order is None or order.user_id != user_id:
        raise BookingError("BOOKING_NOT_FOUND", "预订不存在或不属于当前用户", 404)
    return attempt, order


async def create_booking(user_id: str, flight_no: str, date: str, fare_product: str,
                         passenger: str) -> dict:
    """使用服务端航班票价快照创建待支付订单，订单、预订和审计同事务提交。"""
    now = utcnow()
    booking_id = f"bk_{uuid.uuid4().hex}"
    order_id = f"ORD{uuid.uuid4().hex[:24].upper()}"
    async with SessionFactory() as session:
        flight = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == flight_no.upper(), FlightRecord.date == date).with_for_update())
        if flight is None:
            raise BookingError("FLIGHT_NOT_FOUND", "航班不存在", 404)
        if flight.status != "scheduled":
            raise BookingError("FLIGHT_UNAVAILABLE", "该航班当前不可预订")
        if flight.date < S.now().date().isoformat():
            raise BookingError("FLIGHT_DEPARTED", "该航班的起飞日期已过，无法预订")
        if fare_product not in (flight.fares or {}):
            raise BookingError("FARE_UNAVAILABLE", "该航班没有所选票价产品")
        fare = int(flight.fares[fare_product])
        cabin = PRODUCTS.get(fare_product, (fare_product, fare_product))[0]
        order = OrderRecord(order_id=order_id, user_id=user_id, passenger=passenger.strip(),
                            flight_no=flight.flight_no, date=flight.date, airline=flight.airline,
                            cabin=cabin, fare_product=fare_product, fare=fare, tax=TAX, currency="CNY",
                            status="PENDING_PAYMENT", ticket_no="", created_at=now, updated_at=now,
                            paid_at=None)
        attempt = BookingAttemptRecord(booking_id=booking_id, order_id=order_id, user_id=user_id,
                                       payment_idempotency_key=None, created_at=now, updated_at=now)
        # 先写订单再写预订：booking_attempts 有指向 orders 的外键，而工作单元不会按裸外键排序。
        session.add(order)
        await session.flush()
        session.add(attempt)
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=user_id,
                                action="booking.created", resource_id=booking_id,
                                payload={"order_id": order_id, "flight_no": flight.flight_no,
                                         "date": flight.date, "fare_product": fare_product,
                                         "fare": fare, "tax": TAX, "total": fare + TAX, "currency": "CNY",
                                         "status": "PENDING_PAYMENT", "inventory_source": "local_sql_snapshot"},
                                created_at=now))
        await session.commit()
        await sync_agent_projection(session)
        return _booking_out(order, attempt)


async def get_booking(booking_id: str, user_id: str) -> dict:
    """读取当前主体自有预订及最新支付状态；纯读取不是幂等重放。"""
    async with SessionFactory() as session:
        attempt, order = await _owned_booking(session, booking_id, user_id)
        return _booking_out(order, attempt)


async def pay_booking(booking_id: str, user_id: str, idempotency_key: str) -> dict:
    """以原子状态迁移完成模拟支付；同键重放返回首个结果且不重复审计或刷新。"""
    async with SessionFactory() as session:
        attempt, order = await _owned_booking(session, booking_id, user_id, for_update=True)
        if order.status == "ISSUED":
            if attempt.payment_idempotency_key != idempotency_key:
                raise BookingError("IDEMPOTENCY_CONFLICT", "订单已使用另一幂等键完成模拟支付")
            return _booking_out(order, attempt, idempotent=True)
        if order.status != "PENDING_PAYMENT":
            raise BookingError("BOOKING_NOT_PAYABLE", "当前订单状态不允许模拟支付")
        flight = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == order.flight_no, FlightRecord.date == order.date))
        if flight is None or flight.status != "scheduled":
            raise BookingError("FLIGHT_UNAVAILABLE", "该航班已取消或不可预订，无法完成支付")
        if order.fare_product not in (flight.fares or {}):
            raise BookingError("FARE_UNAVAILABLE", "该航班当前没有所选票价产品")
        key_owner = await session.scalar(select(BookingAttemptRecord).where(
            BookingAttemptRecord.payment_idempotency_key == idempotency_key))
        if key_owner is not None and key_owner.booking_id != booking_id:
            raise BookingError("IDEMPOTENCY_CONFLICT", "支付幂等键已用于另一预订")

        now = utcnow()
        ticket_no = _ticket_no(booking_id, idempotency_key)
        # 即使 SQLite 忽略行锁，条件更新也只允许一个请求完成状态迁移。
        changed = await session.execute(update(OrderRecord).where(
            OrderRecord.order_id == order.order_id,
            OrderRecord.status == "PENDING_PAYMENT").values(
                status="ISSUED", ticket_no=ticket_no, paid_at=now, updated_at=now))
        if changed.rowcount != 1:
            await session.rollback()
            attempt, order = await _owned_booking(session, booking_id, user_id)
            if order.status == "ISSUED" and attempt.payment_idempotency_key == idempotency_key:
                return _booking_out(order, attempt, idempotent=True)
            raise BookingError("IDEMPOTENCY_CONFLICT", "订单已由另一支付请求处理")
        order.status, order.ticket_no, order.paid_at, order.updated_at = "ISSUED", ticket_no, now, now
        attempt.payment_idempotency_key, attempt.updated_at = idempotency_key, now
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=user_id,
                                action="booking.payment.succeeded", resource_id=booking_id,
                                payload={"order_id": order.order_id, "status": "ISSUED",
                                         "ticket_no": ticket_no, "total": order.fare + order.tax,
                                         "currency": order.currency, "provider": "mock",
                                         "real_funds": False, "idempotency_key": idempotency_key},
                                created_at=now))
        try:
            await session.commit()
        except IntegrityError:
            # 数据库唯一约束兜底并发重放；回滚本事务后读取已提交胜出的结果。
            await session.rollback()
            attempt, order = await _owned_booking(session, booking_id, user_id)
            if order.status == "ISSUED" and attempt.payment_idempotency_key == idempotency_key:
                return _booking_out(order, attempt, idempotent=True)
            key_owner = await session.scalar(select(BookingAttemptRecord).where(
                BookingAttemptRecord.payment_idempotency_key == idempotency_key))
            if key_owner is not None and key_owner.booking_id != booking_id:
                raise BookingError("IDEMPOTENCY_CONFLICT", "支付幂等键已用于另一预订")
            raise
        await sync_agent_projection(session)
        return _booking_out(order, attempt)
