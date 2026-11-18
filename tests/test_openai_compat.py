import asyncio
import copy
import json

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import config as S
from app.api.main import app
from app.application.agents.llm import DeepSeekClient, LLMError
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


def test_host_identity_header_authorises_order_intent(client):
    """本机演示宿主可注入身份头；缺失时仍要求显式用户。"""
    body = {
        "model": "aeroagent-mock",
        "messages": [{"role": "user", "content": "查询张三的订单列表"}],
        "tools": [{"type": "function", "function": {"name": "aeroagent_list_orders"}}],
    }
    response = client.post("/v1/chat/completions", json=body,
                           headers={"x-aeroagent-user": "u_zhang"})
    assert response.status_code == 200
    call = response.json()["choices"][0]["message"]["tool_calls"][0]
    assert json.loads(call["function"]["arguments"]) == {"user_id": "u_zhang"}

    rejected = client.post("/v1/chat/completions", json=body,
                           headers={"x-aeroagent-user": "bad user!"})
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "INVALID_USER"


def test_mock_tier_delegates_order_intent_to_host_tool(client):
    response = client.post("/v1/chat/completions", json={
        "model": "aeroagent-mock",
        "metadata": {"user_id": "u_zhang"},
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
        "metadata": {"user_id": "u_zhang"},
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

    async def fake_run(message, case_id=None, **kwargs):
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
    assert "[aeroagent-case]: # \"case_id=case_abc\"" in content
    request = openai_compat.CompatRequest(metadata={"user_id": "u_zhang"}, messages=[
        {"role": "user", "content": "改签"},
        {"role": "assistant", "content": content},
        {"role": "user", "content": "后天"},
    ])
    calls = []

    async def fake_run(message, case_id=None, **kwargs):
        calls.append((message, case_id))
        return {"case_id": case_id, "status": "NEEDS_INFORMATION",
                "clarify": {"question": "请继续补充"}}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    asyncio.run(openai_compat._completion_content(request))
    assert calls == [("后天", "case_abc")]


def test_historical_tool_result_does_not_override_new_servicing_turn(monkeypatch):
    calls = []

    async def fake_run(message, case_id=None, **kwargs):
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
    result = asyncio.run(openai_compat._run_servicing_case(
        "继续办理", unknown.case_id, user_id="u_zhang"))
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


def test_actionable_quotes_render_as_readable_sections_without_raw_json():
    quote = {"quote_id": "q_1", "case_id": "case_abc", "order_id": "ORD1",
             "action": "REFUND", "amount": 400, "currency": "CNY",
             "expires_at": "2026-11-18T12:00:00Z", "fee_items": [],
             "rule_refs": ["R1"], "target": None}
    content = openai_compat._render_case_result({
        "case_id": "case_abc", "status": "WAITING_CONFIRMATION",
        "quotes": [quote, {**quote, "quote_id": "q_2", "action": "CHANGE",
                           "target": {"flight_no": "MU5101", "date": "2026-11-20", "dep_time": "07:00"}}],
    })
    assert content.count("### 退票方案") == 1
    assert content.count("### 改签方案") == 1
    assert "```aeroagent-quote" not in content
    assert '"quote_id"' not in content
    assert content.count("[aeroagent-case]: #") == 1


def test_deepseek_model_threads_real_mode_without_mutating_global_config(monkeypatch):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    before = copy.deepcopy(S.get())
    calls = []

    async def fake_run(message, case_id=None, **kwargs):
        calls.append(kwargs)
        return {"case_id": "case_deepseek", "user_id": "u_li", "status": "PROPOSED", "final": "真实模型"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(
        model="aeroagent-deepseek", metadata={"user_id": "u_li"},
        messages=[{"role": "user", "content": "帮我退票"}])

    content, tool_calls = asyncio.run(openai_compat._completion_content(request))

    assert tool_calls is None and "真实模型" in content
    assert calls[0]["mode"] == "deepseek" and calls[0]["strict"] is True
    assert calls[0]["user_id"] == "u_li"
    assert S.get() == before


def test_mock_model_stays_offline_and_infers_selected_order_owner(monkeypatch):
    from app.adapters.outbound.sqlite import data
    data.init(force=True)
    S.update({"llm": {"api_key": "sk-test-000000"}})
    calls = []

    async def fake_run(message, case_id=None, **kwargs):
        calls.append(kwargs)
        return {"case_id": "case_mock", "user_id": "u_li", "status": "PROPOSED", "final": "离线"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(
        model="aeroagent-mock",
        messages=[{"role": "user", "content": "@ORD20260926004 帮我退票"}])

    asyncio.run(openai_compat._completion_content(request))

    assert calls[0]["mode"] == "mock" and calls[0]["strict"] is False
    assert calls[0]["user_id"] == "u_li"


def test_unknown_model_fails_before_case_handling(monkeypatch):
    calls = []

    async def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return {"final": "不应执行"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(
        model="unknown-model", messages=[{"role": "user", "content": "退票"}])

    with pytest.raises(HTTPException) as caught:
        asyncio.run(openai_compat._completion_content(request))

    assert caught.value.status_code == 400
    assert calls == []


def test_strict_provider_error_is_visible_and_retryable(monkeypatch):
    async def provider_failure(*args, **kwargs):
        raise LLMError("DeepSeek unavailable", code="LLM_REQUEST_FAILED", retryable=True)

    monkeypatch.setattr(openai_compat, "_run_servicing_case", provider_failure)
    payload = {"model": "aeroagent-deepseek", "metadata": {"user_id": "u_li"},
               "messages": [{"role": "user", "content": "帮我退票"}]}
    # 与 compat fixture 一样不进入 lifespan，避免测试 broker 跨事件循环绑定。
    test_client = TestClient(app, raise_server_exceptions=False)
    response = test_client.post("/v1/chat/completions", json=payload)

    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "LLM_REQUEST_FAILED"
    assert error["details"]["retryable"] is True
    assert "工具返回" not in response.text and "离线" not in response.text


def test_malformed_provider_response_is_visible_retryable_error(monkeypatch):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[])), strict=True)

    async def malformed_provider(*args, **kwargs):
        return client.react([])

    monkeypatch.setattr(openai_compat, "_run_servicing_case", malformed_provider)
    payload = {"model": "aeroagent-deepseek", "metadata": {"user_id": "u_li"},
               "messages": [{"role": "user", "content": "帮我退票"}]}
    test_client = TestClient(app, raise_server_exceptions=False)
    response = test_client.post("/v1/chat/completions", json=payload)

    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "LLM_RESPONSE_INVALID"
    assert error["details"]["retryable"] is True


def test_sanitized_dsh_title_payload_is_local_only(monkeypatch, client):
    calls = []

    async def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return {"final": "不应创建案件"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    payload = {
        "model": "aeroagent-deepseek",
        "messages": [
            {"role": "system", "content": (
                "Create a concise title for an AI coding-assistant session from the supplied human messages. "
                "Return only the title.")},
            {"role": "user", "content": (
                "Generate the session title from this JSON array of human messages:\n"
                '[{"role":"user","content":"帮我改签到11.23"}]')},
        ],
        "tools": [],
    }

    response = client.post("/v1/chat/completions", json=payload)

    assert response.status_code == 200
    content = response.json()["choices"][0]["message"]["content"]
    assert "帮我改签到11.23" in content
    assert "aeroagent-case" not in content
    assert calls == []


def test_host_metadata_only_turn_is_local_only(monkeypatch):
    calls = []

    async def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return {"final": "不应创建案件"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(model="aeroagent-deepseek", messages=[
        {"role": "user", "content": "Time sampled while preparing turn 1, step 1: 2026-11-18T12:22:50+08:00[Asia/Shanghai]"},
        {"role": "user", "content": "<system-reminder>host metadata</system-reminder>"},
    ])

    content, tool_calls = asyncio.run(openai_compat._completion_content(request))

    assert content == "" and tool_calls is None
    assert calls == []


def test_case_metadata_carries_user_identity_across_turns(monkeypatch):
    rendered = openai_compat._render_case_result({
        "case_id": "case_li", "user_id": "u_li", "status": "PROPOSED", "final": "继续"})
    assert "user=u_li" in rendered
    calls = []

    async def fake_run(message, case_id=None, **kwargs):
        calls.append(kwargs)
        return {"case_id": case_id, "user_id": kwargs["user_id"], "status": "PROPOSED", "final": "已继续"}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    request = openai_compat.CompatRequest(metadata={"user_id": "u_li"}, messages=[
        {"role": "user", "content": "@ORD20260926004 帮我退票"},
        {"role": "assistant", "content": rendered},
        {"role": "user", "content": "继续"},
    ])

    asyncio.run(openai_compat._completion_content(request))

    assert calls[0]["user_id"] == "u_li"


def test_anonymous_case_continuation_requires_identity_before_case_read(monkeypatch):
    from types import SimpleNamespace
    from app.adapters.outbound.postgres import database
    from app.adapters.outbound.postgres.models import ServiceCaseRecord

    owned = SimpleNamespace(case_id="case_li", user_id="u_li", order_id=None,
                            session_id="compat_li", status="RESULT_UNKNOWN", result={})
    reads = []

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key):
            reads.append(key)
            return owned if model is ServiceCaseRecord else None

    monkeypatch.setattr(database, "SessionFactory", Session)
    rendered = openai_compat._render_case_result({
        "case_id": "case_li", "user_id": "u_li", "status": "PROPOSED", "final": "继续"})
    request = openai_compat.CompatRequest(messages=[
        {"role": "assistant", "content": rendered},
        {"role": "user", "content": "继续"},
    ])

    with pytest.raises(HTTPException) as caught:
        asyncio.run(openai_compat._completion_content(request))
    assert caught.value.status_code == 400
    assert caught.value.detail["code"] == "USER_REQUIRED"
    assert reads == []

    with pytest.raises(HTTPException) as direct:
        asyncio.run(openai_compat._run_servicing_case("继续", "case_li"))
    assert direct.value.status_code == 400
    assert direct.value.detail["code"] == "USER_REQUIRED"
    assert reads == []


def test_new_case_uses_selected_order_owner_and_requested_mode(monkeypatch):
    from app.adapters.outbound.postgres import database
    from app.adapters.outbound.postgres.models import ServiceCaseRecord
    from app.adapters.outbound.sqlite import data
    from app.application.cases import service as case_service

    data.init(force=True)
    created, turns = [], []

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key):
            return created[0] if created and model is ServiceCaseRecord else None
        async def scalars(self, _): return []
        def add(self, row): created.append(row)
        async def commit(self): pass

    async def fake_turn(payload):
        turns.append(payload)
        created[0].result = {"final": "完成"}
        return {}

    monkeypatch.setattr(database, "SessionFactory", Session)
    monkeypatch.setattr(case_service, "SessionFactory", Session)
    monkeypatch.setattr(case_service, "run_case_turn", fake_turn)

    result = asyncio.run(openai_compat._run_servicing_case(
        "@ORD20260926004 帮我退票", mode="deepseek"))

    assert result["user_id"] == "u_li"
    assert created[0].user_id == "u_li"
    assert turns[0]["user_id"] == "u_li"
    assert turns[0]["mode"] == "deepseek" and turns[0]["strict"] is True


def test_case_resume_rejects_explicit_different_user(monkeypatch):
    from types import SimpleNamespace
    from app.adapters.outbound.postgres import database
    from app.adapters.outbound.postgres.models import ServiceCaseRecord
    from app.application.cases import service as case_service

    owned = SimpleNamespace(case_id="case_zhang", user_id="u_zhang", order_id=None,
                            session_id="compat_zhang", status="OPEN", result={})
    created, turns = [], []

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key): return owned if model is ServiceCaseRecord else None
        def add(self, row): created.append(row)
        async def commit(self): pass

    async def fake_turn(payload): turns.append(payload)

    monkeypatch.setattr(database, "SessionFactory", Session)
    monkeypatch.setattr(case_service, "SessionFactory", Session)
    monkeypatch.setattr(case_service, "run_case_turn", fake_turn)

    with pytest.raises(HTTPException) as caught:
        asyncio.run(openai_compat._run_servicing_case(
            "继续", "case_zhang", user_id="u_li"))

    assert caught.value.status_code == 404
    assert created == [] and turns == []


def test_compat_requests_are_throttled_per_user(monkeypatch, client):
    async def local_completion(request):
        return "ok", None

    monkeypatch.setattr(openai_compat, "_completion_content", local_completion)
    S.update({"compat": {"requests_per_minute": 1}})
    getattr(openai_compat, "_request_times", {}).clear()
    payload = {"model": "aeroagent-mock", "metadata": {"user_id": "u_li"},
               "messages": [{"role": "user", "content": "退票"}]}
    try:
        first = client.post("/v1/chat/completions", json=payload)
        second = client.post("/v1/chat/completions", json=payload)
        other_user = client.post("/v1/chat/completions", json={
            **payload, "metadata": {"user_id": "u_zhang"}})
    finally:
        getattr(openai_compat, "_request_times", {}).clear()

    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "RATE_LIMITED"
    assert other_user.status_code == 200


def test_selected_order_only_traffic_is_throttled_by_order_owner(monkeypatch, client):
    async def local_completion(request):
        return "ok", None

    monkeypatch.setattr(openai_compat, "_completion_content", local_completion)
    S.update({"compat": {"requests_per_minute": 1}})
    getattr(openai_compat, "_request_times", {}).clear()
    payload = {"model": "aeroagent-mock", "messages": [{"role": "user", "content": "退票"}]}
    li_order = {**payload, "metadata": {"selected_order_id": "ORD20260926004"}}
    zhang_order = {**payload, "metadata": {"selected_order_id": "ORD20260926001"}}
    try:
        first = client.post("/v1/chat/completions", json=li_order)
        second = client.post("/v1/chat/completions", json=li_order)
        other_owner = client.post("/v1/chat/completions", json=zhang_order)
    finally:
        getattr(openai_compat, "_request_times", {}).clear()

    assert first.status_code == 200
    assert second.status_code == 429
    assert other_owner.status_code == 200
