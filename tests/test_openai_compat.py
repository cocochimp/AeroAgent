import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.api.main import app
from app.adapters.inbound.http import openai_compat


@pytest.fixture()
def client():
    # 不进入 lifespan：compat 端点契约不需要启动期 seed/worker，但需先建好 SQLite 投影表
    from app.adapters.outbound.sqlite import data
    data.init(force=True)
    yield TestClient(app)


def test_models_list_exposes_both_decision_tiers(client):
    response = client.get("/v1/models")
    assert response.status_code == 200
    ids = [item["id"] for item in response.json()["data"]]
    assert ids == ["aeroagent-mock", "aeroagent-deepseek"]


def test_mock_tier_delegates_order_intent_to_host_tool(client):
    response = client.post("/v1/chat/completions", json={
        "model": "aeroagent-mock",
        "messages": [{"role": "user", "content": "查询张三的订单列表"}],
        "tools": [{"type": "function", "function": {"name": "aeroagent_list_orders"}}],
    })
    assert response.status_code == 200
    choice = response.json()["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    call = choice["message"]["tool_calls"][0]
    assert call["function"]["name"] == "aeroagent_list_orders"
    assert json.loads(call["function"]["arguments"])["user_id"] == "u_zhang"


def test_tool_result_is_summarized_back_to_host(client):
    response = client.post("/v1/chat/completions", json={
        "model": "aeroagent-mock",
        "messages": [
            {"role": "user", "content": "查询张三的订单列表"},
            {"role": "tool", "tool_call_id": "call_1", "content": "Orders:\nORD1 MU5101 ISSUED"},
        ],
    })
    body = response.json()["choices"][0]["message"]["content"]
    assert "ORD1" in body and "工具返回" in body


def test_stream_mode_emits_sse_chunks_and_done(client):
    with client.stream("POST", "/v1/chat/completions", json={
        "model": "aeroagent-mock",
        "stream": True,
        "messages": [{"role": "tool", "tool_call_id": "call_1", "content": "Orders:\nORD2 CA5102 ISSUED"}],
    }) as response:
        assert response.status_code == 200
        lines = [line for line in response.iter_lines() if line.startswith("data: ")]
    assert lines[-1] == "data: [DONE]"
    first = json.loads(lines[0][len("data: "):])
    assert first["object"] == "chat.completion.chunk"


def test_plain_question_runs_the_servicing_mainline(client):
    response = client.post("/v1/chat/completions", json={
        "model": "aeroagent-mock",
        "messages": [{"role": "user", "content": "改签需要什么手续费？"}],
    })
    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert content.strip()
    assert response.json()["usage"]["total_tokens"] > 0


def test_case_metadata_round_trips_through_assistant_history(monkeypatch):
    content = openai_compat._render_case_result({
        "case_id": "case_abc",
        "status": "NEEDS_INFORMATION",
        "clarify": {"question": "想改到哪一天？"},
    })
    assert "```aeroagent-case" in content
    assert '"case_id": "case_abc"' in content
    request = openai_compat.CompatRequest(messages=[
        {"role": "user", "content": "改签"},
        {"role": "assistant", "content": content},
        {"role": "user", "content": "后天"},
    ])
    calls = []

    async def fake_run(message, case_id=None):
        calls.append((message, case_id))
        return {"case_id": case_id, "status": "NEEDS_INFORMATION",
                "clarify": {"question": "请继续补充"}}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    asyncio.run(openai_compat._completion_content(request))
    assert calls == [("后天", "case_abc")]


def test_each_actionable_quote_has_its_own_fence():
    quote = {"quote_id": "q_1", "case_id": "case_abc", "order_id": "ORD1",
             "action": "REFUND", "amount": 400, "currency": "CNY",
             "expires_at": "2026-11-18T12:00:00Z", "fee_items": [],
             "rule_refs": ["R1"], "target": None}
    content = openai_compat._render_case_result({
        "case_id": "case_abc", "status": "WAITING_CONFIRMATION",
        "quotes": [quote, {**quote, "quote_id": "q_2", "action": "CHANGE"}],
    })
    assert content.count("```aeroagent-quote") == 2
    assert content.count("```aeroagent-case") == 1
