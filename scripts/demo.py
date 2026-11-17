#!/usr/bin/env python3
"""仅供本地使用的演示数据命令；不得暴露为远程 API。"""
import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.adapters.outbound.sqlite import data as legacy_data
from app.adapters.outbound.postgres.database import SessionFactory, initialize_schema
from app.adapters.outbound.postgres.models import FlightRecord
from app.adapters.outbound.postgres.seed import seed_demo_data


async def reset():
    """重建业务库和 Agent 投影的演示数据；只供本地命令显式调用。"""
    await initialize_schema()
    async with SessionFactory() as session:
        await seed_demo_data(session, force=True)
    legacy_data.init(force=True)
    print("演示用户、订单、航班和规则已重置。")


async def flight_status(flight_no: str, date: str, status: str, delay_min: int):
    """同步修改业务库和投影中的航班状态；用于演示非自愿退改分支。"""
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
    """解析本地演示数据命令；不暴露远程管理入口。"""
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("reset", help="重置业务库与检索投影 SQLite 演示数据")
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
