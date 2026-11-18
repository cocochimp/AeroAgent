"""原生 DSH 会话的端到端回归：身份、开案、方案、续办、换票与租户隔离。

运行在进程内（不访问外网）：决策模式用确定性的 mock，界面契约与真实模式一致。
"""
import asyncio
import json
import re

import pytest
from fastapi.testclient import TestClient

from app.api.main import app
from app.adapters.inbound.http import openai_compat as compat
from app.adapters.outbound.postgres import database
from app.adapters.outbound.postgres.seed import seed_demo_data
from app.adapters.outbound.sqlite import data

MARKER = re.compile(r'\[aeroagent-case\]: # "case_id=(case_[0-9a-f]+)(?: user=([A-Za-z0-9_-]+))?"')


def _prepare_database():
    data.init(force=True)

    async def prepare():
        await database.initialize_schema()
        async with database.SessionFactory() as session:
            await seed_demo_data(session, force=True)

    asyncio.run(prepare())


def _chat(client, *messages, model="aeroagent-mock"):
    response = client.post("/v1/chat/completions", json={
        "model": model,
        "messages": [{"role": role, "content": content} for role, content in messages],
    })
    return response


def _content(response):
    assert response.status_code == 200, response.text
    return response.json()["choices"][0]["message"]["content"]


def _case_id(content):
    match = MARKER.search(content)
    assert match, f"答复缺少案件元数据：{content}"
    return match.group(1), match.group(2)


@pytest.fixture()
def native():
    _prepare_database()
    yield TestClient(app)


def test_change_quote_for_selected_ticket_is_human_readable(native):
    """选中客票后直接得到可读的改签方案与真实案件，金额与引擎一致。"""
    content = _content(_chat(native, ("user", "@ORD20260926010 帮我改签到后天，请生成可选方案，并说明差价和手续费。")))
    case_id, owner = _case_id(content)

    assert owner == "u_zhang"
    assert "### 改签方案" in content
    assert "| 应付合计 |" in content
    assert "quote_id" not in content and "```" not in content
    assert content.count("[aeroagent-case]: #") == 1
    assert "\n\n[aeroagent-case]: #" in content, "元数据必须独立成段，Markdown 才会隐藏"

    case = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_zhang"}).json()
    assert case["order_id"] == "ORD20260926010"
    assert case["status"] == "WAITING_CONFIRMATION"
    assert [quote["action"] for quote in case["quotes"]] == ["CHANGE"]
    quote = case["quotes"][0]
    assert quote["amount"] > 0
    assert quote["details"][0]["pricing"]["total"] == quote["amount"]
    assert f"| 应付合计 | ¥{quote['amount']} |" in content


def test_cancelled_flight_change_is_free(native):
    """航司取消属于非自愿改签：改期费与差价都必须为 0，而不是随意估价。"""
    content = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天，请生成可选方案。")))
    case_id, _ = _case_id(content)

    assert "| 应付合计 | ¥0 |" in content
    case = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_wang"}).json()
    pricing = case["quotes"][0]["details"][0]["pricing"]
    assert pricing["involuntary"] is True
    assert pricing["change_fee"] == 0 and pricing["fare_diff"] == 0


def test_case_is_not_visible_to_another_passenger(native):
    content = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天。")))
    case_id, _ = _case_id(content)

    denied = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_li"})
    assert denied.status_code == 404


def test_follow_up_without_ticket_token_resumes_the_same_case(native):
    first = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天，请生成可选方案。")))
    case_id, _ = _case_id(first)

    second = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天，请生成可选方案。"),
                            ("assistant", first),
                            ("user", "为什么改期费是这个金额？")))
    resumed, owner = _case_id(second)

    assert resumed == case_id, "追问必须回到同一个案件"
    assert owner == "u_wang"


def test_switching_ticket_starts_a_new_case_for_the_new_ticket(native):
    first = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天，请生成可选方案。")))
    case_id, _ = _case_id(first)

    second = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天。"),
                            ("assistant", first),
                            ("user", "@ORD20260926008 这单退票怎么算？")))
    switched, owner = _case_id(second)

    assert switched != case_id
    assert owner == "u_wang"
    fresh = native.get(f"/api/v1/cases/{switched}", headers={"Authorization": "Bearer demo:u_wang"}).json()
    assert fresh["order_id"] == "ORD20260926008"


def test_refund_request_renders_refund_plan(native):
    content = _content(_chat(native, ("user", "@ORD20260926008 航班取消了，请按票规计算退票费和最终退款。")))
    case_id, _ = _case_id(content)

    assert "### 退票方案" in content
    assert "预计退款" in content
    case = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_wang"}).json()
    assert case["quotes"][0]["action"] == "REFUND"
    assert case["quotes"][0]["amount"] >= 0


def test_unknown_ticket_is_rejected_before_any_case_is_created(native):
    response = _chat(native, ("user", "@ORD99999999999 帮我改签到后天。"))
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "ORDER_NOT_FOUND"


def test_internal_quote_ids_never_reach_the_transcript(native):
    content = _content(_chat(native, ("user", "@ORD20260926007 帮我改签到后天，请生成可选方案。")))
    case_id, _ = _case_id(content)
    case = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_wang"}).json()

    for quote in case["quotes"]:
        assert quote["quote_id"] not in content
        assert json.dumps(quote, ensure_ascii=False) not in content

def test_confirmed_quote_runs_the_transaction_to_a_new_ticket(native):
    """确认方案后必须真正走完交易：案件 COMPLETED、报价 EXECUTED、产生新票号。"""
    from app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent

    content = _content(_chat(native, ("user", "@ORD20260926010 帮我改签到后天，请生成可选方案。")))
    case_id, _ = _case_id(content)
    case = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_zhang"}).json()
    quote = case["quotes"][0]
    assert quote["status"] == "OFFERED"

    confirmed = native.post(f"/api/v1/quotes/{quote['quote_id']}/confirm",
                            json={"confirmation_id": "confirm-e2e", "idempotency_key": "ticket-e2e"},
                            headers={"Authorization": "Bearer demo:u_zhang"})
    assert confirmed.status_code == 202, confirmed.text
    operation_id = confirmed.json()["operation_id"]

    asyncio.run(TicketTransactionAgent().execute(ConfirmedQuoteCommand(operation_id)))

    done = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_zhang"}).json()
    assert done["status"] == "COMPLETED"
    assert done["result"]["operation"]["status"] == "CHANGED"
    assert done["result"]["operation"]["ticket_no"]
    assert done["quotes"][0]["status"] == "EXECUTED"
    order = native.get("/api/v1/orders?q=ORD20260926010",
                       headers={"Authorization": "Bearer demo:u_zhang"}).json()
    assert order["orders"][0]["ticket_no"] == done["result"]["operation"]["ticket_no"]


def test_confirmation_is_idempotent_for_the_same_key(native):
    """相同幂等键重放不会重复出票，也不会产生第二笔操作。"""
    from app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent

    content = _content(_chat(native, ("user", "@ORD20260926008 帮我改签到后天。")))
    case_id, _ = _case_id(content)
    case = native.get(f"/api/v1/cases/{case_id}", headers={"Authorization": "Bearer demo:u_wang"}).json()
    if not case["quotes"]:
        pytest.skip("该演示订单不可改签，跳过确认链路")
    quote = case["quotes"][0]
    body = {"confirmation_id": "confirm-replay", "idempotency_key": "ticket-replay"}
    first = native.post(f"/api/v1/quotes/{quote['quote_id']}/confirm", json=body,
                        headers={"Authorization": "Bearer demo:u_wang"})
    assert first.status_code == 202, first.text
    asyncio.run(TicketTransactionAgent().execute(ConfirmedQuoteCommand(first.json()["operation_id"])))
    replay = native.post(f"/api/v1/quotes/{quote['quote_id']}/confirm", json=body,
                         headers={"Authorization": "Bearer demo:u_wang"})
    assert replay.status_code == 202
    assert replay.json()["operation_id"] == first.json()["operation_id"]
    assert replay.json()["idempotent"] is True
