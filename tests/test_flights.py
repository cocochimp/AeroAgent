import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.inbound.http.auth import Principal
from app.adapters.outbound.postgres.models import Base, FlightRecord, OrderRecord
from app.adapters.outbound.postgres.seed import seed_demo_data


USER = Principal("u_zhang", frozenset({"user"}))


def _run_with_db(tmp_path, monkeypatch, callback):
    async def run():
        from app.adapters.inbound.http import flights as api

        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'flights.db'}")
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as session:
            await seed_demo_data(session, force=True)
        monkeypatch.setattr(api, "SessionFactory", factory)
        try:
            return await callback(api, factory)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def test_listing_filters_route_date_and_cabin_with_server_fares(tmp_path, monkeypatch):
    async def check(api, factory):
        async with factory() as session:
            order = await session.scalar(select(OrderRecord).where(OrderRecord.order_id.like("ORD%001")))
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.flight_no == order.flight_no, FlightRecord.date == order.date))

        result = await api.list_flights(USER, origin=flight.origin, dest=flight.dest,
                                        date=flight.date, cabin="Y")

        assert result["flights"]
        assert len(result["flights"]) == 4
        for item in result["flights"]:
            assert (item["origin"], item["dest"], item["date"]) == (flight.origin, flight.dest, flight.date)
            assert item["available"] is True
            assert item["unavailable_reason"] is None
            assert item["fares"]
            assert {fare["cabin"] for fare in item["fares"]} == {"Y"}
            assert all(fare["total"] == fare["fare"] + fare["tax"] for fare in item["fares"])
            assert all(fare["currency"] == "CNY" for fare in item["fares"])

    _run_with_db(tmp_path, monkeypatch, check)


def test_listing_keeps_cancelled_flights_visible_but_unavailable(tmp_path, monkeypatch):
    async def check(api, factory):
        async with factory() as session:
            cancelled = await session.scalar(select(FlightRecord).where(FlightRecord.status == "cancelled"))

        result = await api.list_flights(USER, origin=cancelled.origin, dest=cancelled.dest,
                                        date=cancelled.date)
        item = next(row for row in result["flights"] if row["flight_no"] == cancelled.flight_no)

        assert item["status"] == "cancelled"
        assert item["available"] is False
        assert item["unavailable_reason"] == "FLIGHT_CANCELLED"
        assert all(fare["available"] is False for fare in item["fares"])

    _run_with_db(tmp_path, monkeypatch, check)


def test_listing_router_is_registered_and_requires_auth():
    from fastapi.testclient import TestClient
    from app.api.main import app

    response = TestClient(app).get("/api/v1/flights")

    assert response.status_code == 401


def test_listing_marks_departed_flights_unavailable(tmp_path, monkeypatch):
    async def check(api, factory):
        from app import config as S

        async with factory() as session:
            past = await session.scalar(select(FlightRecord).where(
                FlightRecord.date < S.now().date().isoformat()).order_by(FlightRecord.date))
        result = await api.list_flights(USER, date=past.date)
        assert result["flights"]
        for item in result["flights"]:
            assert item["available"] is False
            assert item["unavailable_reason"] in {"FLIGHT_DEPARTED", "FLIGHT_CANCELLED", "FLIGHT_NOT_BOOKABLE"}

    _run_with_db(tmp_path, monkeypatch, check)
