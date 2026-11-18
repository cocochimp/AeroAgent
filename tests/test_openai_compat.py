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


def test_dsh_timing_metadata_does_not_replace_business_message():
    request = openai_compat.CompatRequest(messages=[
        {"role": "user", "content": "@ORD20261118010 帮我办理退票"},
        {"role": "user", "content": "Time sampled while preparing turn 1, step 1: 2026-11-18T12:22:50+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.\nElapsed since the preceding model-visible message: unavailable."},
    ])
    assert openai_compat._last_user(request) == "@ORD20261118010 帮我办理退票"


def test_dsh_system_reminder_does_not_replace_business_message():
    request = openai_compat.CompatRequest(messages=[
        {"role": "user", "content": "@ORD20261118010 帮我办理退票"},
        {"role": "user", "content": "<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>"},
    ])
    assert openai_compat._last_user(request) == "@ORD20261118010 帮我办理退票"


def test_dsh_runtime_context_does_not_replace_business_message():
    request = openai_compat.CompatRequest(messages=[
        {"role": "user", "content": "@ORD20261118010 帮我办理退票"},
        {"role": "user", "content": "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: /repo."},
    ])
    assert openai_compat._last_user(request) == "@ORD20261118010 帮我办理退票"


def test_refund_intent_takes_priority_over_order_list_delegation(monkeypatch):
    calls = []

    async def fake_run(message, case_id=None):
        calls.append((message, case_id))
        return {"case_id": "case_refund", "status": "PROPOSED", "final": "退票方案"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(
        messages=[{"role": "user", "content": "Order ORD20261118010 帮我办理退票"}],
        tools=[{"type": "function", "function": {"name": "aeroagent_list_orders"}}],
    )
    _, tool_calls = asyncio.run(openai_compat._completion_content(request))
    assert tool_calls is None
    assert calls == [("Order ORD20261118010 帮我办理退票", None)]


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


def test_historical_tool_result_does_not_override_new_servicing_turn(monkeypatch):
    calls = []

    async def fake_run(message, case_id=None):
        calls.append((message, case_id))
        return {"case_id": "case_refund_after_tool", "status": "PROPOSED", "final": "退票方案"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(messages=[
        {"role": "user", "content": "查询我的订单"},
        {"role": "assistant", "content": None},
        {"role": "tool", "tool_call_id": "call_1", "content": "Orders: ORD1 ISSUED"},
        {"role": "assistant", "content": "【AeroAgent】工具返回：Orders: ORD1 ISSUED"},
        {"role": "user", "content": "@ORD1 帮我办理退票"},
    ])
    content, tool_calls = asyncio.run(openai_compat._completion_content(request))
    assert tool_calls is None
    assert "退票方案" in content
    assert calls == [("@ORD1 帮我办理退票", None)]


def test_result_unknown_continuation_requires_reconciliation_without_new_case(monkeypatch):
    from types import SimpleNamespace
    from app.adapters.outbound.postgres import database
    from app.adapters.outbound.postgres.models import ServiceCaseRecord
    from app.application.cases import service as case_service

    unknown = SimpleNamespace(case_id="case_unknown", user_id="u_zhang", order_id="ORD1",
                              session_id="compat_unknown", status="RESULT_UNKNOWN",
                              current_quote_id="q_unknown", result={"operation": {"status": "TIMEOUT"}})
    created, turns = [], []

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key):
            return unknown if model is ServiceCaseRecord and key == unknown.case_id else None
        async def scalars(self, _): return []
        def add(self, row): created.append(row)
        async def commit(self): pass

    async def fake_turn(payload):
        turns.append(payload)
        return {}

    monkeypatch.setattr(database, "SessionFactory", Session)
    monkeypatch.setattr(case_service, "SessionFactory", Session)
    monkeypatch.setattr(case_service, "run_case_turn", fake_turn)
    result = asyncio.run(openai_compat._run_servicing_case("继续办理", unknown.case_id))
    assert result["case_id"] == unknown.case_id
    assert result["status"] == "RESULT_UNKNOWN"
    assert "核对" in result["final"]
    assert created == [] and turns == []


def test_structured_final_without_text_serializes_instead_of_failing():
    content = openai_compat._render_case_result({
        "case_id": "case_human", "status": "HUMAN_REVIEW",
        "final": {"reasons": ["需要人工核对"]},
    })
    assert "需要人工核对" in content
    assert "case_human" in content


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
