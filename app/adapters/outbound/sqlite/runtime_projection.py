"""把业务状态投影到 Agent 的 SQLite 只读边界。"""
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.outbound.sqlite import data
from app.adapters.outbound import retrieval
from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import (
    FeeRuleRecord, FlightRecord, OrderRecord, ProfileRecord, RuleRecord,
)


async def sync_agent_projection(session: AsyncSession) -> None:
    """用当前业务快照重建 Agent 只读表，避免写侧表结构渗入推理链。"""
    data.init()
    flights = list(await session.scalars(select(FlightRecord)))
    orders = list(await session.scalars(select(OrderRecord)))
    profiles = list(await session.scalars(select(ProfileRecord)))
    fee_rules = list(await session.scalars(select(FeeRuleRecord)))
    rules = list(await session.scalars(select(RuleRecord).where(RuleRecord.active.is_(True))))

    with data.transaction() as conn:
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
        data._bump_rules_version(conn)
    retrieval.invalidate()


async def persist_agent_profile(session: AsyncSession, user_id: str) -> None:
    """把当前用户的 Agent 画像更新回写业务事实表。"""
    profile = data.get_profile(user_id)
    row = await session.get(ProfileRecord, user_id)
    if profile is not None and row is not None:
        row.data = profile["data"]
        await session.commit()


async def sync_rules_to_agent_index() -> None:
    """政策编辑后同步刷新 Agent 检索投影，使新规则立即可见。"""
    async with SessionFactory() as session:
        await sync_agent_projection(session)
