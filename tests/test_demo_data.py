from datetime import datetime

from app.demo_data import load_demo_seed


def test_demo_seed_has_current_business_scenarios_and_stable_counts():
    seed = load_demo_seed(datetime(2026, 9, 26, 10, 0))

    assert len(seed["users"]) == 4
    assert len(seed["profiles"]) == 4
    assert len(seed["flights"]) == 4 * 5 * 16
    assert len(seed["orders"]) == 13
    assert len(seed["fee_rules"]) == 4 * 6
    assert len(seed["policy_rules"]) == 4 * 6 * 2 + 4
    assert {row["status"] for row in seed["flights"]} >= {"scheduled", "cancelled", "delayed"}
    assert {row["fare_product"] for row in seed["orders"]} == {"F", "C", "Y", "Y_DISCOUNT", "SPECIAL", "GROUP"}
    assert all("metrics" not in row for rows in seed.values() for row in rows)


def test_demo_seed_dates_and_today_departure_follow_clock():
    morning = load_demo_seed(datetime(2026, 9, 26, 10, 0))
    evening = load_demo_seed(datetime(2026, 9, 26, 22, 0))

    assert morning["orders"][0]["order_id"].startswith("ORD20260926")
    today_order = next(row for row in evening["orders"] if row["date"] == "2026-09-26")
    flight = next(row for row in evening["flights"] if row["flight_no"] == today_order["flight_no"] and row["date"] == today_order["date"])
    assert flight["dep_time"] == "23:59"


def test_demo_seed_fee_table_matches_airline_and_fare_product():
    seed = load_demo_seed(datetime(2026, 9, 26, 10, 0))
    ca_y = next(row for row in seed["fee_rules"] if row["airline"] == "CA" and row["fare_product"] == "Y")
    assert ca_y["data"]["refund"] == [15, 20, 25, 30, 45]
