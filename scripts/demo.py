#!/usr/bin/env python3
"""Local-only demo data commands. Never expose these as remote API endpoints."""
import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from air_agent import data as legacy_data
from backend.app.adapters.outbound.postgres.database import SessionFactory
from backend.app.adapters.outbound.postgres.models import FlightRecord
from backend.app.adapters.outbound.postgres.seed import seed_demo_data


async def reset():
    async with SessionFactory() as session:
        await seed_demo_data(session, force=True)
    legacy_data.init(force=True)
    print("演示用户、订单、航班和规则已重置。")


async def flight_status(flight_no: str, date: str, status: str, delay_min: int):
    legacy_data.init()
    async with SessionFactory() as session:
        row = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == flight_no, FlightRecord.date == date))
        if row is None:
            raise SystemExit(f"找不到航班：{flight_no} {date}")
        row.status, row.delay_min = status, delay_min
        await session.commit()
    legacy_data.set_flight_status(flight_no, date, status=status, delay_min=delay_min)
    print(f"航班状态已更新：{flight_no} {date} -> {status} / {delay_min} 分钟")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("reset", help="重置 PostgreSQL 与 CLI SQLite 演示数据")
    flight = commands.add_parser("flight-status", help="模拟演示航班状态变化")
    flight.add_argument("flight_no")
    flight.add_argument("date", help="YYYY-MM-DD")
    flight.add_argument("status", choices=("scheduled", "delayed", "cancelled"))
    flight.add_argument("--delay-min", type=int, default=0)
    args = parser.parse_args()
    if args.command == "reset":
        asyncio.run(reset())
    else:
        asyncio.run(flight_status(args.flight_no, args.date, args.status, args.delay_min))


if __name__ == "__main__":
    main()
