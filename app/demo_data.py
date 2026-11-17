"""共享虚构工作台数据，并按当前日期确定性生成业务种子。"""
from __future__ import annotations

import copy
import json
from datetime import date, datetime, timedelta
from pathlib import Path

_FIXTURES = Path(__file__).resolve().parent.parent / "demo_data"


def _read(name: str):
    return json.loads((_FIXTURES / name).read_text("utf-8"))


def _fee_table(config: dict) -> dict[tuple[str, str], dict]:
    fees = config["base_rates"]
    offsets = _read("flights.json")["airline_offset"]
    return {
        (airline, product): {
            action: None if rates is None else [min(100, rate + offsets[airline]) if rate > 0 else 0 for rate in rates]
            for action, rates in product_rates.items()
        }
        for airline in offsets
        for product, product_rates in fees.items()
    }


def _flight_no(airline_index: int, route_index: int, airline: str) -> str:
    return f"{airline}{5101 + route_index * 10 + airline_index}"


def _fare_for(base: int, product: str, day: date, airline_index: int, config: dict) -> int:
    factor = config["product_factor"][product]
    multiplier = config["day_mult"][(day.toordinal() + airline_index) % 7]
    return int(round(base * factor * multiplier / 10) * 10)


def load_demo_seed(now: datetime | None = None) -> dict:
    """返回可独立修改的业务演示数据，日期相对 ``now`` 生成。"""
    now = now or datetime.now().astimezone()
    today = now.date()
    flight_config, fee_config = _read("flights.json"), _read("fee_rules.json")
    products, airlines = flight_config["products"], flight_config["airlines"]
    flight_rows = []
    for airline_index, airline in enumerate(airlines):
        for route_index, (origin, dest, origin_city, dest_city, base) in enumerate(flight_config["routes"]):
            dep_hour = 7 + (route_index * 3 + airline_index * 2) % 14
            for offset in flight_config["offsets"]:
                day = today + timedelta(days=offset)
                flight_rows.append({
                    "flight_no": _flight_no(airline_index, route_index, airline), "date": day.isoformat(),
                    "airline": airline, "origin": origin, "dest": dest, "origin_city": origin_city,
                    "dest_city": dest_city, "dep_time": f"{dep_hour:02d}:{airline_index * 15:02d}",
                    "duration_min": 130, "status": "scheduled", "delay_min": 0,
                    "fares": {product: _fare_for(base, product, day, airline_index, flight_config) for product in products},
                })
    by_key = {(row["flight_no"], row["date"]): row for row in flight_rows}
    order_rows = []
    for index, spec in enumerate(_read("orders.json"), start=1):
        airline_index = list(airlines).index(spec["airline"])
        day = today + timedelta(days=spec["day_offset"])
        flight = by_key[(_flight_no(airline_index, spec["route_idx"], spec["airline"]), day.isoformat())]
        if spec["day_offset"] == 0:
            departure = now + timedelta(hours=3)
            flight["dep_time"] = f"{departure.hour:02d}:{departure.minute:02d}" if departure.date() == today else "23:59"
        flight["status"], flight["delay_min"] = spec["flight_status"], spec["delay_min"]
        product = spec["fare_product"]
        order_rows.append({"order_id": f"ORD{today:%Y%m%d}{index:03d}", "user_id": spec["user_id"],
            "passenger": spec["passenger"], "flight_no": flight["flight_no"], "date": flight["date"],
            "airline": spec["airline"], "cabin": products[product][0], "fare_product": product,
            "fare": flight["fares"][product], "tax": fee_config["tax"], "status": "ISSUED",
            "ticket_no": f"781-{2400000000 + index}"})
    fees = _fee_table(fee_config)
    # 政策文案与费率表来自同一套演示配置，避免费用和规则解释互相矛盾。
    policies = _read("policy_rules.json")
    return {"users": _read("users.json"), "flights": flight_rows, "orders": order_rows,
            "profiles": _read("profiles.json"),
            "fee_rules": [{"airline": a, "fare_product": p, "data": value} for (a, p), value in fees.items()],
            "policy_rules": copy.deepcopy(policies)}
