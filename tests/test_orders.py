import asyncio
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.inbound.http import orders as api
from app.adapters.inbound.http.auth import Principal
from app.adapters.outbound.postgres.models import Base, OrderRecord
from app.adapters.outbound.postgres.seed import seed_demo_data
from sqlalchemy import select


USER = Principal("u_zhang", frozenset({"user"}))


def _run_with_db(tmp_path, monkeypatch, callback):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'orders.db'}")
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as session:
            await seed_demo_data(session, force=True)
        monkeypatch.setattr(api, "SessionFactory", factory)
        try:
            return await callback(factory)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def test_orders_default_to_stable_creation_descending_and_expose_currency(tmp_path, monkeypatch):
    async def check(factory):
        async with factory() as session:
            rows = list(await session.scalars(select(OrderRecord).where(OrderRecord.user_id == USER.user_id)))
            created_at = datetime(2026, 9, 26, 8, 0, tzinfo=timezone.utc)
            for row in rows:
                row.created_at = created_at
            await session.commit()

        result = await api.list_orders(USER)

        expected = sorted((row.order_id for row in rows), reverse=True)
        assert [row["order_id"] for row in result["orders"]] == expected
        assert result["page"] == 1
        assert result["page_size"] == 20
        assert result["total"] == len(rows)
        assert result["sort"] == "created_at"
        assert result["order"] == "desc"
        assert all(row["currency"] == "CNY" for row in result["orders"])
        assert all(row["created_at"] == created_at for row in result["orders"])

    _run_with_db(tmp_path, monkeypatch, check)


def test_order_search_is_user_scoped_and_matches_route_and_order_fields(tmp_path, monkeypatch):
    async def check(_):
        own = await api.list_orders(USER, q="ORD")
        route = await api.list_orders(Principal("u_li", frozenset({"user"})), q="CTU")
        other_users_route = await api.list_orders(USER, q="CTU")

        assert own["total"] == 4
        assert {row["user_id"] for row in own["orders"]} == {USER.user_id}
        assert route["total"] == 2
        assert {row["user_id"] for row in route["orders"]} == {"u_li"}
        assert all(row["flight"]["dest"] == "CTU" for row in route["orders"])
        assert other_users_route["orders"] == []
        assert other_users_route["total"] == 0

    _run_with_db(tmp_path, monkeypatch, check)


def test_order_departure_sort_and_pages_are_stable(tmp_path, monkeypatch):
    async def check(factory):
        async with factory() as session:
            rows = list(await session.scalars(select(OrderRecord).where(OrderRecord.user_id == USER.user_id)))
            expected = []
            for row in rows:
                from app.adapters.outbound.postgres.models import FlightRecord
                flight = await session.scalar(select(FlightRecord).where(
                    FlightRecord.flight_no == row.flight_no, FlightRecord.date == row.date))
                expected.append((row.date, flight.dep_time, row.order_id))
            expected.sort()

        first = await api.list_orders(USER, sort="departure", order="asc", page=1, page_size=2)
        second = await api.list_orders(USER, sort="departure", order="asc", page=2, page_size=2)
        third = await api.list_orders(USER, sort="departure", order="asc", page=3, page_size=2)

        actual = first["orders"] + second["orders"]
        assert [row["order_id"] for row in actual] == [item[2] for item in expected]
        assert len({row["order_id"] for row in actual}) == 4
        assert first["total"] == second["total"] == 4
        assert first["total_pages"] == second["total_pages"] == 2
        assert third["orders"] == []
        assert third["page"] == 3

    _run_with_db(tmp_path, monkeypatch, check)
