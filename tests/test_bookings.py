import asyncio
import re

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.inbound.http.auth import Principal
from app.adapters.outbound.postgres.models import (
    AuditRecord, Base, BookingAttemptRecord, FlightRecord, OrderRecord,
)
from app.adapters.outbound.postgres.seed import seed_demo_data


USER = Principal("u_zhang", frozenset({"user"}))
OTHER_USER = Principal("u_li", frozenset({"user"}))


def _run_with_db(tmp_path, monkeypatch, callback):
    async def run():
        from app.adapters.inbound.http import bookings as api
        from app.application import booking as service

        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'bookings.db'}")
        from sqlalchemy import event

        @event.listens_for(engine.sync_engine, "connect")
        def _fk_on(dbapi_connection, _):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as session:
            await seed_demo_data(session, force=True)
            from app import config as S
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.status == "scheduled", FlightRecord.fares.is_not(None),
                FlightRecord.date >= S.now().date().isoformat()).order_by(FlightRecord.date))
            selected = (flight.flight_no, flight.date, flight.fares["Y"])
        monkeypatch.setattr(service, "SessionFactory", factory)
        projections = []

        async def project(_):
            projections.append(True)

        monkeypatch.setattr(service, "sync_agent_projection", project)
        try:
            return await callback(api, service, factory, selected, projections)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _command(selected):
    flight_no, date, _ = selected
    return {"flight_no": flight_no, "date": date, "fare_product": "Y", "passenger": "张三"}


def test_booking_uses_server_snapshot_and_enforces_ownership(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, projections):
        expected_fare = selected[2]
        result = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)

        assert re.fullmatch(r"ORD\d{11}", result["order_id"]), "订单号必须沿用业务统一格式"
        assert result["status"] == "PENDING_PAYMENT"
        assert result["user_id"] == USER.user_id
        assert result["fare"] == expected_fare
        assert result["tax"] == 50
        assert result["total"] == expected_fare + 50
        assert result["currency"] == "CNY"
        assert result["ticket_no"] == ""
        assert result["paid_at"] is None
        assert result["inventory_source"] == "local_sql_snapshot"
        assert len(projections) == 1

        async with factory() as session:
            order = await session.get(OrderRecord, result["order_id"])
            attempt = await session.get(BookingAttemptRecord, result["booking_id"])
            assert order.status == "PENDING_PAYMENT"
            assert order.fare == expected_fare
            assert order.user_id == USER.user_id
            assert attempt.user_id == USER.user_id
            assert attempt.payment_idempotency_key is None
            audit = await session.scalar(select(AuditRecord).where(
                AuditRecord.action == "booking.created", AuditRecord.resource_id == result["booking_id"]))
            assert audit.actor_id == USER.user_id
            assert audit.payload["total"] == expected_fare + 50

        with pytest.raises(HTTPException) as denied:
            await api.get_booking(result["booking_id"], OTHER_USER)
        assert denied.value.status_code == 404

    _run_with_db(tmp_path, monkeypatch, check)


def test_booking_request_rejects_client_price_user_and_status_fields():
    from app.adapters.inbound.http import bookings as api

    with pytest.raises(ValidationError):
        api.BookingCreateRequest(flight_no="MU5101", date="2026-09-28", fare_product="Y",
                                 passenger="张三", user_id="u_li", fare=1, tax=0,
                                 total=1, currency="USD", status="ISSUED")


def test_mock_payment_is_idempotent_and_refreshes_projection_once(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, projections):
        created = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        payment = api.MockPaymentRequest(idempotency_key="payment-key-0001")

        first = await api.pay_booking(created["booking_id"], payment, USER)
        replay = await api.pay_booking(created["booking_id"], payment, USER)

        assert first["status"] == replay["status"] == "ISSUED"
        assert first["ticket_no"].startswith("781-")
        assert replay["ticket_no"] == first["ticket_no"]
        assert first["paid_at"] == replay["paid_at"]
        assert first["idempotent"] is False
        assert replay["idempotent"] is True
        assert first["payment"] == {"provider": "mock", "status": "SUCCEEDED",
                                    "idempotency_key": "payment-key-0001", "real_funds": False}
        assert len(projections) == 2
        async with factory() as session:
            order = await session.get(OrderRecord, created["order_id"])
            attempt = await session.get(BookingAttemptRecord, created["booking_id"])
            assert order.status == "ISSUED"
            assert order.paid_at is not None
            assert attempt.payment_idempotency_key == "payment-key-0001"
            assert await session.scalar(select(func.count()).select_from(AuditRecord).where(
                AuditRecord.resource_id == created["booking_id"])) == 2

    _run_with_db(tmp_path, monkeypatch, check)


def test_concurrent_mock_payment_replays_one_committed_result(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, projections):
        created = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        payment = api.MockPaymentRequest(idempotency_key="payment-key-concurrent")

        results = await asyncio.gather(
            api.pay_booking(created["booking_id"], payment, USER),
            api.pay_booking(created["booking_id"], payment, USER),
        )

        assert {result["status"] for result in results} == {"ISSUED"}
        assert len({result["ticket_no"] for result in results}) == 1
        assert sum(result["idempotent"] for result in results) == 1
        assert len(projections) == 2
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(AuditRecord).where(
                AuditRecord.action == "booking.payment.succeeded")) == 1

    _run_with_db(tmp_path, monkeypatch, check)


def test_payment_key_cannot_be_reused_for_a_different_booking(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, _projections):
        first = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        second = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        payment = api.MockPaymentRequest(idempotency_key="payment-key-shared")
        await api.pay_booking(first["booking_id"], payment, USER)

        with pytest.raises(HTTPException) as conflict:
            await api.pay_booking(second["booking_id"], payment, USER)

        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == "IDEMPOTENCY_CONFLICT"
        async with factory() as session:
            assert (await session.get(OrderRecord, second["order_id"])).status == "PENDING_PAYMENT"
            assert await session.scalar(select(func.count()).select_from(AuditRecord).where(
                AuditRecord.action == "booking.payment.succeeded")) == 1

    _run_with_db(tmp_path, monkeypatch, check)


def test_other_user_cannot_pay_and_cancelled_flight_cannot_be_booked(tmp_path, monkeypatch):
    async def check(api, _service, factory, selected, _projections):
        created = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        with pytest.raises(HTTPException) as denied:
            await api.pay_booking(created["booking_id"],
                                  api.MockPaymentRequest(idempotency_key="payment-key-0002"), OTHER_USER)
        assert denied.value.status_code == 404

        async with factory() as session:
            flight = await session.scalar(select(FlightRecord).where(FlightRecord.status == "cancelled"))
            cancelled = (flight.flight_no, flight.date, None)
            assert (await session.get(OrderRecord, created["order_id"])).status == "PENDING_PAYMENT"
        with pytest.raises(HTTPException) as unavailable:
            await api.create_booking(api.BookingCreateRequest(**_command(cancelled)), USER)
        assert unavailable.value.status_code == 409
        assert unavailable.value.detail["code"] == "FLIGHT_UNAVAILABLE"

    _run_with_db(tmp_path, monkeypatch, check)


def test_demo_reset_clears_booking_and_watch_dependents(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, _projections):
        from app.adapters.inbound.http import orders as orders_api
        from app.application import monitoring
        from app.adapters.outbound.postgres.models import PriceWatchRecord

        await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        monkeypatch.setattr(monitoring, "SessionFactory", factory)
        await monitoring.create_watch(USER.user_id, selected[0], selected[1], "Y",
                                      target_total=selected[2])
        monkeypatch.setattr(orders_api, "SessionFactory", factory)

        async def no_projection(_):
            return None

        monkeypatch.setattr(orders_api, "sync_agent_projection", no_projection)
        result = await orders_api.mutate_demo_data(
            orders_api.DemoDataCommand(action="reset_demo_data"),
            Principal("u_zhang", frozenset({"user", "admin"})))

        assert result["result"] == {"reset": True}
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(BookingAttemptRecord)) == 0
            assert await session.scalar(select(func.count()).select_from(PriceWatchRecord)) == 0

    _run_with_db(tmp_path, monkeypatch, check)


def test_booking_routes_require_authentication():
    from fastapi.testclient import TestClient
    from app.api.main import app

    client = TestClient(app)
    assert client.post("/api/v1/bookings", json={}).status_code == 401
    assert client.post("/api/v1/bookings/bk_1/pay", json={}).status_code == 401


def test_reading_an_issued_booking_is_not_a_replay(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, projections):
        created = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        await api.pay_booking(created["booking_id"], api.MockPaymentRequest(idempotency_key="payment-read-1"), USER)

        read = await api.get_booking(created["booking_id"], USER)

        assert read["status"] == "ISSUED"
        assert read["idempotent"] is False, "纯读取不能声称是幂等重放"

    _run_with_db(tmp_path, monkeypatch, check)


def test_payment_revalidates_flight_availability(tmp_path, monkeypatch):
    async def check(api, service, factory, selected, projections):
        created = await api.create_booking(api.BookingCreateRequest(**_command(selected)), USER)
        async with factory() as session:
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.flight_no == selected[0], FlightRecord.date == selected[1]))
            flight.status = "cancelled"
            await session.commit()

        with pytest.raises(HTTPException) as rejected:
            await api.pay_booking(created["booking_id"], api.MockPaymentRequest(idempotency_key="payment-cancel-1"), USER)
        assert rejected.value.status_code == 409
        assert rejected.value.detail["code"] == "FLIGHT_UNAVAILABLE"

        async with factory() as session:
            order = await session.get(OrderRecord, created["order_id"])
        assert order.status == "PENDING_PAYMENT", "取消的航班不能出票"
        assert order.ticket_no == ""

    _run_with_db(tmp_path, monkeypatch, check)


def test_booking_rejects_a_departed_flight(tmp_path, monkeypatch):
    async def check(api, _, factory, selected, projections):
        from app import config as S

        async with factory() as session:
            past = await session.scalar(select(FlightRecord).where(
                FlightRecord.date < S.now().date().isoformat(),
                FlightRecord.status == "scheduled", FlightRecord.fares.is_not(None)).order_by(FlightRecord.date))
        assert past is not None
        with pytest.raises(HTTPException) as rejected:
            await api.create_booking(api.BookingCreateRequest(
                flight_no=past.flight_no, date=past.date, fare_product="Y", passenger="王五"), USER)
        assert rejected.value.status_code == 409
        assert rejected.value.detail["code"] == "FLIGHT_DEPARTED"
        assert projections == [], "被拒绝的预订不应刷新投影"

    _run_with_db(tmp_path, monkeypatch, check)
