from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.adapters.outbound.sqlite import data
from app import config as settings
from app.adapters.outbound.sqlite.runtime_projection import sync_agent_projection
from app.adapters.outbound.postgres.models import FeeRuleRecord, FlightRecord, OrderRecord, ProfileRecord, RuleRecord


class FakeSession:
    def __init__(self, rows):
        self.rows = rows

    async def scalars(self, statement):
        model = statement.column_descriptions[0]["entity"]
        rows = self.rows.get(model, [])
        filters = {}
        def collect(node):
            if hasattr(node, "left") and hasattr(node, "right") and hasattr(node.left, "name"):
                filters[node.left.name] = getattr(node.right, "value", None)
            elif hasattr(node, "get_children"):
                for child in node.get_children():
                    collect(child)
        for criterion in statement._where_criteria:
            collect(criterion)
        if model is not OrderRecord:
            return rows
        return [row for row in rows if all(getattr(row, k, object()) == v for k, v in filters.items())]


def test_projection_reads_current_postgres_flight_order_fee_profile_and_rules(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "VAR_DIR", tmp_path)
    data.init(force=True)
    order = data.list_orders("u_zhang")[0]
    flight = data.get_flight(order["flight_no"], order["date"])
    flight["status"], flight["delay_min"] = "cancelled", 0
    profile = data.get_profile("u_zhang")
    profile["data"] = {"routes": {"HGH-PEK": 99}}
    fee = data.get_fee_rule("MU", "Y_DISCOUNT")
    fee["refund"] = [1, 2, 3, 4, 5]
    rule = data.get_rule("MU-Y_DISCOUNT-RFD")

    rows = {
        FlightRecord: [SimpleNamespace(**flight)],
        OrderRecord: [SimpleNamespace(**order)],
        ProfileRecord: [SimpleNamespace(**profile)],
        FeeRuleRecord: [SimpleNamespace(airline="MU", fare_product="Y_DISCOUNT", data=fee)],
        RuleRecord: [SimpleNamespace(**{**rule, "active": True, "updated_at": datetime.now(timezone.utc)})],
    }
    import asyncio
    asyncio.run(sync_agent_projection(FakeSession(rows)))

    projected = data.get_flight(order["flight_no"], order["date"])
    assert (projected["status"], projected["delay_min"]) == ("cancelled", 0)
    assert data.get_order(order["order_id"])["user_id"] == "u_zhang"
    assert data.get_profile("u_zhang")["data"]["routes"]["HGH-PEK"] == 99
    assert data.get_fee_rule("MU", "Y_DISCOUNT")["refund"] == [1, 2, 3, 4, 5]
    assert data.get_rule("MU-Y_DISCOUNT-RFD")["content"] == rule["content"]


class FakeQuerySession(FakeSession):
    def __init__(self, rows):
        super().__init__(rows)
        self.added = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def scalar(self, statement):
        model = statement.column_descriptions[0]["entity"]
        rows = self.rows.get(model, [])
        filters = {}
        for criterion in statement._where_criteria:
            for node in criterion.get_children():
                if hasattr(node, "left") and hasattr(node, "right") and hasattr(node.left, "name"):
                    filters[node.left.name] = getattr(node.right, "value", None)
        return next((row for row in rows if all(getattr(row, k) == v for k, v in filters.items())), None)

    async def get(self, model, key):
        field = {ProfileRecord: "user_id"}.get(model, "order_id")
        return next((row for row in self.rows.get(model, []) if getattr(row, field) == key), None)

    def add(self, row):
        self.added.append(row)

    async def commit(self):
        return None


def test_order_api_scopes_passengers_and_exposes_admin_inventory(monkeypatch):
    from app.adapters.inbound.http import orders as api
    from app.adapters.inbound.http.auth import Principal

    flight = SimpleNamespace(flight_no="MU5101", date="2026-09-28", origin="HGH", dest="PEK",
        origin_city="杭州", dest_city="北京", dep_time="10:00", status="scheduled", delay_min=0)
    rows = {
        OrderRecord: [SimpleNamespace(order_id="O1", user_id="u1", passenger="张三", flight_no="MU5101",
            date="2026-09-28", airline="MU", cabin="Y", fare_product="Y", fare=500, tax=50,
            status="ISSUED", ticket_no="T1"), SimpleNamespace(order_id="O2", user_id="u2", passenger="李四",
            flight_no="MU5101", date="2026-09-28", airline="MU", cabin="Y", fare_product="Y", fare=500,
            tax=50, status="ISSUED", ticket_no="T2")],
        FlightRecord: [flight],
        ProfileRecord: [SimpleNamespace(user_id="u1", name="张三", tier="金卡", data={}),
                        SimpleNamespace(user_id="u2", name="李四", tier="银卡", data={})],
    }
    session = FakeQuerySession(rows)
    monkeypatch.setattr(api, "SessionFactory", lambda: session)

    async def call():
        passenger = await api.list_orders(Principal("u1", frozenset({"user"})))
        admin = await api.list_orders(Principal("admin", frozenset({"user", "admin"})))
        return passenger, admin
    import asyncio
    passenger, admin = asyncio.run(call())
    assert {o["order_id"] for o in passenger["orders"]} == {"O1"}
    assert {o["order_id"] for o in admin["orders"]} == {"O1", "O2"}
    assert {u["user_id"] for u in admin["users"]} == {"u1", "u2"}


def test_admin_can_change_flight_status_and_projection_refreshes(monkeypatch):
    from app.adapters.inbound.http import orders as api
    from app.adapters.inbound.http.auth import Principal

    flight = SimpleNamespace(flight_no="MU5101", date="2026-09-28", status="scheduled", delay_min=0)
    rows = {FlightRecord: [flight]}
    session = FakeQuerySession(rows)
    monkeypatch.setattr(api, "SessionFactory", lambda: session)
    projected = []
    async def project(current_session):
        projected.append(flight.status)
    monkeypatch.setattr(api, "sync_agent_projection", project)

    async def call():
        return await api.mutate_demo_data(api.DemoDataCommand(action="set_flight_status", flight_no="MU5101",
            date="2026-09-28", status="cancelled"), Principal("admin", frozenset({"admin"})))
    import asyncio
    result = asyncio.run(call())
    assert result["result"]["status"] == "cancelled"
    assert projected == ["cancelled"]


def test_start_evaluation_binds_selected_cases_to_persisted_version(monkeypatch):
    import asyncio
    from datetime import datetime, timezone
    from app.adapters.inbound.http import admin
    from app.adapters.inbound.http.auth import Principal
    from app.adapters.outbound.postgres.models import EvaluationCaseSetRecord, EvaluationRunRecord
    cases = [{"id": "a", "question": "退票", "expect": {"outcome": "ANSWER"}},
             {"id": "b", "question": "改签", "expect": {"outcome": "ANSWER"}}]
    case_set = SimpleNamespace(version="v2", cases=cases, created_at=datetime.now(timezone.utc))
    session = FakeQuerySession({EvaluationCaseSetRecord: [case_set]})
    monkeypatch.setattr(admin, "SessionFactory", lambda: session)

    async def call():
        return await admin.start_evaluation(admin.EvalRunRequest(mode="offline", case_ids=["b"]),
                                            Principal("admin", frozenset({"admin"})))
    result = asyncio.run(call())
    run = next(row for row in session.added if isinstance(row, EvaluationRunRecord))
    assert result["status"] == "QUEUED"
    assert run.progress["case_set_version"] == "v2"
    assert run.progress["case_snapshot"] == [cases[1]]
