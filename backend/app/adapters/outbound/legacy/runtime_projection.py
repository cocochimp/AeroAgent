"""Project PostgreSQL business state into the legacy Agent's SQLite boundary."""
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from air_agent import data as legacy_data
from air_agent import retrieval
from backend.app.adapters.outbound.postgres.models import (
    FeeRuleRecord, FlightRecord, OrderRecord, ProfileRecord, RuleRecord,
)


async def sync_agent_projection(session: AsyncSession) -> None:
    """Replace Agent read tables with the current PostgreSQL business snapshot."""
    legacy_data.init()
    flights = list(await session.scalars(select(FlightRecord)))
    orders = list(await session.scalars(select(OrderRecord)))
    profiles = list(await session.scalars(select(ProfileRecord)))
    fee_rules = list(await session.scalars(select(FeeRuleRecord)))
    rules = list(await session.scalars(select(RuleRecord).where(RuleRecord.active.is_(True))))

    with legacy_data.transaction() as conn:
        for table in ("flights", "orders", "profiles", "fee_rules", "rules"):
            conn.execute(f"DELETE FROM {table}")
        conn.executemany(
            "INSERT INTO flights VALUES(:flight_no,:date,:airline,:origin,:dest,:origin_city,:dest_city,"
            ":dep_time,:duration_min,:status,:delay_min,:fares)",
            [{"flight_no": row.flight_no, "date": row.date, "airline": row.airline,
              "origin": row.origin, "dest": row.dest, "origin_city": row.origin_city,
              "dest_city": row.dest_city, "dep_time": row.dep_time, "duration_min": row.duration_min,
              "status": row.status, "delay_min": row.delay_min,
              "fares": json.dumps(row.fares, ensure_ascii=False)} for row in flights],
        )
        conn.executemany(
            "INSERT INTO orders VALUES(:order_id,:user_id,:passenger,:flight_no,:date,:airline,:cabin,"
            ":fare_product,:fare,:tax,:status,:ticket_no)",
            [{key: getattr(row, key) for key in (
                "order_id", "user_id", "passenger", "flight_no", "date", "airline", "cabin",
                "fare_product", "fare", "tax", "status", "ticket_no")} for row in orders],
        )
        conn.executemany("INSERT INTO profiles VALUES(:user_id,:name,:tier,:data)",
            [{"user_id": row.user_id, "name": row.name, "tier": row.tier,
              "data": json.dumps(row.data, ensure_ascii=False)} for row in profiles])
        conn.executemany("INSERT INTO fee_rules VALUES(:airline,:fare_product,:data)",
            [{"airline": row.airline, "fare_product": row.fare_product,
              "data": json.dumps(row.data, ensure_ascii=False)} for row in fee_rules])
        conn.executemany("INSERT INTO rules VALUES(:id,:airline,:cabin,:fare_product,:scenario,:title,:content,:ts)",
            [{"id": row.id, "airline": row.airline, "cabin": row.cabin, "fare_product": row.fare_product,
              "scenario": row.scenario, "title": row.title, "content": row.content,
              "ts": row.updated_at.isoformat()} for row in rules])
        legacy_data._bump_rules_version(conn)
    retrieval.invalidate()


async def persist_agent_profile(session: AsyncSession, user_id: str) -> None:
    """Copy the current user's Agent profile updates back to the source of truth."""
    profile = legacy_data.get_profile(user_id)
    row = await session.get(ProfileRecord, user_id)
    if profile is not None and row is not None:
        row.data = profile["data"]
        await session.commit()
