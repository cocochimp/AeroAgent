"""原生 DSH 工具链路的端到端回归：开案、方案、续办、换票与租户隔离。

不经过 OpenAI 兼容层：插件工具直接调用 /api/v1/cases，和真实 DSH 会话同一条链路。
"""
import asyncio
import re

import pytest
from fastapi.testclient import TestClient

from app.adapters.outbound.persistence import database
from app.adapters.outbound.persistence.seed import seed_demo_data
from app.adapters.outbound.sqlite import data
from app.api.main import app

AUTH = {"Authorization": "Bearer demo:u_zhang"}
AUTH_WANG = {"Authorization": "Bearer demo:u_wang"}
AUTH_LI = {"Authorization": "Bearer demo:u_li"}


def _prepare_database():
    data.init(force=True)

    async def prepare():
        await database.initialize_schema()
        async with database.SessionFactory() as session:
            await seed_demo_data(session, force=True)

    asyncio.run(prepare())


def _start(client, message, order_id, headers=AUTH):
    response = client.post("/api/v1/cases?wait=true", headers=headers,
                           json={"message": message, "order_id": order_id})
    assert response.status_code == 202, response.text
    return response.json()


def _continue(client, case_id, message, headers=AUTH):
    response = client.post(f"/api/v1/cases/{case_id}/messages?wait=true", headers=headers,
                           json={"message": message})
    assert response.status_code == 202, response.text
    return response.json()


def _text(case):
    return (case.get("result", {}).get("final") or {}).get("text", "")


@pytest.fixture()
def native():
    _prepare_database()
    with TestClient(app) as client:
        yield client


def test_change_quote_is_structured_and_priced(native):
    """选中客票后得到可办理改签报价，金额来自确定性费用引擎。"""
    case = _start(native, "帮我改签到后天，请生成可选方案，并说明差价和手续费。", "ORD20260926010")
    assert case["order_id"] == "ORD20260926010"
    assert case["status"] == "WAITING_CONFIRMATION"
    assert [quote["action"] for quote in case["quotes"]] == ["CHANGE"]
    quote = case["quotes"][0]
    assert quote["amount"] > 0
    assert quote["details"][0]["pricing"]["total"] == quote["amount"]
    assert "改期费" in _text(case)


def test_cancelled_flight_change_is_free(native):
    """航司取消属于非自愿改签：改期费与差价都必须为 0。"""
    case = _start(native, "帮我改签到后天，请生成可选方案。", "ORD20260926007", AUTH_WANG)
    pricing = case["quotes"][0]["details"][0]["pricing"]
    assert pricing["involuntary"] is True
    assert pricing["change_fee"] == 0 and pricing["fare_diff"] == 0


def test_case_is_not_visible_to_another_passenger(native):
    case = _start(native, "帮我改签到后天。", "ORD20260926007", AUTH_WANG)
    denied = native.get(f"/api/v1/cases/{case['case_id']}", headers=AUTH_LI)
    assert denied.status_code == 404


def test_follow_up_resumes_the_same_case(native):
    """信息不足时追问，补充后必须回到同一个案件。"""
    first = _start(native, "帮我改签。", "ORD20260926007", AUTH_WANG)
    assert first["status"] == "NEEDS_INFORMATION"
    second = _continue(native, first["case_id"], "2026-09-28", AUTH_WANG)
    assert second["case_id"] == first["case_id"]
    assert second["status"] == "WAITING_CONFIRMATION"


def test_switching_ticket_starts_a_new_case(native):
    first = _start(native, "帮我改签到后天，请生成可选方案。", "ORD20260926007", AUTH_WANG)
    second = _start(native, "@ORD20260926008 这单退票怎么算？", "ORD20260926008", AUTH_WANG)
    assert second["case_id"] != first["case_id"]
    assert second["order_id"] == "ORD20260926008"


def test_refund_request_renders_refund_plan(native):
    case = _start(native, "航班取消了，请按票规计算退票费和最终退款。", "ORD20260926008", AUTH_WANG)
    assert case["quotes"][0]["action"] == "REFUND"
    assert case["quotes"][0]["amount"] >= 0
    assert "退款" in _text(case)


def test_unknown_ticket_is_rejected_before_any_case_is_created(native):
    response = native.post("/api/v1/cases?wait=true", headers=AUTH,
                           json={"message": "帮我改签到后天。", "order_id": "ORD99999999999"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "ORDER_NOT_FOUND"


def test_internal_quote_ids_never_reach_the_transcript(native):
    case = _start(native, "帮我改签到后天，请生成可选方案。", "ORD20260926007", AUTH_WANG)
    text = _text(case)
    for quote in case["quotes"]:
        assert quote["quote_id"] not in text


def test_confirmed_quote_runs_the_transaction_to_a_new_ticket(native):
    """确认方案后必须真正走完交易：案件 COMPLETED、报价 EXECUTED、产生新票号。"""
    from app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent

    case = _start(native, "帮我改签到后天，请生成可选方案。", "ORD20260926010")
    quote = case["quotes"][0]
    assert quote["status"] == "OFFERED"

    confirmed = native.post(f"/api/v1/quotes/{quote['quote_id']}/confirm",
                            json={"confirmation_id": "confirm-e2e", "idempotency_key": "ticket-e2e"},
                            headers=AUTH)
    assert confirmed.status_code == 202, confirmed.text
    operation_id = confirmed.json()["operation_id"]
    asyncio.run(TicketTransactionAgent().execute(ConfirmedQuoteCommand(operation_id)))

    done = native.get(f"/api/v1/cases/{case['case_id']}", headers=AUTH).json()
    assert done["status"] == "COMPLETED"
    assert done["result"]["operation"]["status"] == "CHANGED"
    assert done["result"]["operation"]["ticket_no"]
    assert done["quotes"][0]["status"] == "EXECUTED"
    order = native.get("/api/v1/orders?q=ORD20260926010", headers=AUTH).json()
    assert order["orders"][0]["ticket_no"] == done["result"]["operation"]["ticket_no"]


def test_confirmation_is_idempotent_for_the_same_key(native):
    """相同幂等键重放不会重复出票，也不会产生第二笔操作。"""
    from app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent

    case = _start(native, "帮我改签到后天。", "ORD20260926008", AUTH_WANG)
    if not case["quotes"]:
        pytest.skip("该演示订单不可改签，跳过确认链路")
    quote = case["quotes"][0]
    body = {"confirmation_id": "confirm-replay", "idempotency_key": "ticket-replay"}
    first = native.post(f"/api/v1/quotes/{quote['quote_id']}/confirm", json=body, headers=AUTH_WANG)
    assert first.status_code == 202, first.text
    asyncio.run(TicketTransactionAgent().execute(ConfirmedQuoteCommand(first.json()["operation_id"])))
    replay = native.post(f"/api/v1/quotes/{quote['quote_id']}/confirm", json=body, headers=AUTH_WANG)
    assert replay.status_code == 202
    assert replay.json()["operation_id"] == first.json()["operation_id"]
    assert replay.json()["idempotent"] is True


def test_listing_booking_can_be_refunded_in_chat(native):
    """Listing 新下的订单必须能被退改会话识别。"""
    flight = native.get("/api/v1/flights", headers=AUTH_WANG,
                        params={"date": "2026-09-28"}).json()["flights"][0]
    created = native.post("/api/v1/bookings", headers=AUTH_WANG,
                          json={"flight_no": flight["flight_no"], "date": flight["date"],
                                "fare_product": "Y", "passenger": "王五"})
    assert created.status_code == 201, created.text
    booking = created.json()
    order_id = booking["order_id"]
    assert re.fullmatch(r"ORD\d{11}", order_id)
    paid = native.post(f"/api/v1/bookings/{booking['booking_id']}/pay", headers=AUTH_WANG,
                       json={"idempotency_key": "pay-e2e-refund-1"})
    assert paid.status_code == 200, paid.text
    assert paid.json()["status"] == "ISSUED"

    case = _start(native, "帮我退票，请说明退票费和最终退款。", order_id, AUTH_WANG)
    assert case["quotes"][0]["action"] == "REFUND"
    assert "退款" in _text(case)


def test_multi_candidate_change_options_are_priced_and_ranked(native):
    """多方案改签返回 2–5 个候选，独立定价、恰好一个推荐、标识稳定。"""
    first = native.get("/api/v1/orders/ORD20260926010/change-options?date=2026-09-28", headers=AUTH)
    assert first.status_code == 200, first.text
    payload = first.json()
    assert 2 <= len(payload["options"]) <= 5
    assert sum(1 for option in payload["options"] if option["recommended"]) == 1
    assert all(option["total"] >= 0 and option["candidate_id"].startswith("chg_")
               for option in payload["options"])
    second = native.get("/api/v1/orders/ORD20260926010/change-options?date=2026-09-28", headers=AUTH).json()
    assert [option["candidate_id"] for option in second["options"]] == [
        option["candidate_id"] for option in payload["options"]]
