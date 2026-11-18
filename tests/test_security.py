import asyncio
import copy
import json
import threading
from types import SimpleNamespace

import httpx
import pytest

from app import config as S
from app.adapters.outbound.llm.factory import create_decision_engine
from app.application.agents.llm import DeepSeekClient, LLMError
from app.application.agents.models import SchemeOutput


def test_real_clock_is_sampled_in_asia_shanghai(monkeypatch):
    from datetime import datetime as RealDateTime, timezone

    class Clock:
        @classmethod
        def now(cls, tz=None):
            assert tz == timezone.utc
            return RealDateTime(2026, 11, 23, 16, 30, 45, tzinfo=timezone.utc)

    monkeypatch.setattr(S, "datetime", Clock)
    S.set_now(None)

    assert S.now() == RealDateTime(2026, 11, 24, 0, 30)


def test_deepseek_environment_supplies_key_base_url_and_model(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-env-test")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://deepseek.example.test/v1")
    monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-env-model")
    S.reset()

    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(200)))

    assert client.model == "deepseek-env-model"
    assert str(client.http.base_url) == "https://deepseek.example.test/v1/"
    assert client.http.headers["Authorization"] == "Bearer sk-env-test"


@pytest.mark.parametrize("method,args", [
    ("parse_intents", ("改到后天", {}, [])),
    ("summarize", ([],)),
    ("write_scheme", (SchemeOutput(options=[], text=""), [], [], {})),
    ("fact_check", ([], "")),
])
def test_strict_deepseek_auxiliary_failures_are_not_swallowed(method, args):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(503)), strict=True)

    with pytest.raises(LLMError):
        getattr(client, method)(*args)


@pytest.mark.parametrize("payload", [
    [],
    {"choices": [{"message": []}]},
    {"choices": [{"message": {"content": "", "tool_calls": {}}}]},
    {"choices": [{"message": {"tool_calls": [{"function": []}]}}]},
])
def test_malformed_provider_payloads_become_retryable_llm_errors(payload):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload)), strict=True)

    with pytest.raises(LLMError) as caught:
        client.react([])

    assert caught.value.code == "LLM_RESPONSE_INVALID"
    assert caught.value.retryable is True


@pytest.mark.parametrize("target_date", ["2026-09-26", "2026-09-25"])
def test_parse_intents_rejected_provider_iso_clarifies_in_understanding(target_date):
    from app.adapters.outbound.sqlite import data
    from app.application.agents import understanding

    data.init(force=True)
    S.update({"llm": {"api_key": "sk-test-000000"}})
    content = json.dumps({"sub_queries": [
        {"intent": "CHANGE", "text": "改到后天", "target_date": target_date}]})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(
        200, json={"choices": [{"message": {"content": content}}]})), strict=True)

    parsed = understanding.understand("改到后天", {
        "user_id": "u_zhang", "selected_order_id": "ORD20260926001",
        "order_stack": [], "last_intent": None,
    }, llm=client)

    assert parsed.sub_queries[0].target_date is None
    assert parsed.clarify["field"] == "target_date"


def test_strict_summarize_rejects_missing_summary():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(
        200, json={"choices": [{"message": {"content": "{}"}}]})), strict=True)

    with pytest.raises(LLMError) as caught:
        client.summarize([])

    assert caught.value.code == "LLM_RESPONSE_INVALID"
    assert caught.value.retryable is True


@pytest.mark.parametrize("unsupported", [None, "a", {}, [None], [{"text": "a"}], [1]])
def test_strict_fact_check_rejects_malformed_unsupported_values(unsupported):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    content = json.dumps({"unsupported": unsupported})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(
        200, json={"choices": [{"message": {"content": content}}]})), strict=True)

    with pytest.raises(LLMError) as caught:
        client.fact_check(["a"], "规则")

    assert caught.value.code == "LLM_RESPONSE_INVALID"
    assert caught.value.retryable is True


def test_fact_check_allows_missing_optional_unsupported_but_not_null():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(
        200, json={"choices": [{"message": {"content": "{}"}}]})), strict=True)

    assert client.fact_check(["a"], "规则") == []


def test_strict_decision_preserves_original_error_code_and_retryable_flag():
    from app.adapters.outbound.llm.deepseek import DeepSeekDecisionEngine

    original = LLMError("timeout text must not rewrite policy",
                        code="LLM_RESPONSE_INVALID", retryable=False)

    class Client:
        usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}

        def react(self, messages):
            raise original

    engine = DeepSeekDecisionEngine(Client(), strict=True)
    with pytest.raises(LLMError) as caught:
        engine.decide({}, [])

    assert caught.value is original
    assert caught.value.code == "LLM_RESPONSE_INVALID"
    assert caught.value.retryable is False


def test_http_error_status_controls_retryable_policy():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(401)), strict=True)

    with pytest.raises(LLMError) as caught:
        client.chat([])

    assert caught.value.code == "LLM_REQUEST_FAILED"
    assert caught.value.retryable is False


def test_http_400_includes_structured_provider_error_without_request_prompt():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(400, json={
        "error": {"message": "messages.3.content must be a string",
                  "type": "invalid_request_error", "code": "invalid_messages"},
    })), strict=True)

    with pytest.raises(LLMError) as caught:
        client.chat([{"role": "user", "content": "PRIVATE_FULL_PROMPT"}])

    message = str(caught.value)
    assert caught.value.code == "LLM_REQUEST_FAILED"
    assert caught.value.retryable is False
    assert "HTTP 400" in message
    assert "messages.3.content must be a string" in message
    assert "invalid_request_error" in message
    assert "invalid_messages" in message
    assert "PRIVATE_FULL_PROMPT" not in message
    assert "Authorization" not in message


@pytest.mark.parametrize("body", ["not-json", "<html><body>provider proxy failure</body></html>"])
def test_http_error_non_json_or_html_uses_generic_status_message(body):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(
        transport=httpx.MockTransport(lambda request: httpx.Response(400, text=body)), strict=True)

    with pytest.raises(LLMError) as caught:
        client.chat([])

    message = str(caught.value)
    assert message.startswith("HTTPStatusError:")
    assert body not in message
    assert caught.value.code == "LLM_REQUEST_FAILED"
    assert caught.value.retryable is False


def test_http_error_malformed_structured_body_uses_generic_status_message():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(
        400, json={"error": {"message": 123}})), strict=True)

    with pytest.raises(LLMError) as caught:
        client.chat([])

    assert str(caught.value).startswith("HTTPStatusError:")
    assert "123" not in str(caught.value)


def test_http_error_redacts_secret_like_content_and_bounds_message():
    secret = "sk-live-secret-123456"
    provider_message = f"Authorization: Bearer {secret}; api_key={secret}; invalid request " + "x" * 1000
    S.update({"llm": {"api_key": "sk-test-000000"}})
    client = DeepSeekClient(transport=httpx.MockTransport(lambda request: httpx.Response(
        400, json={"error": {"message": provider_message, "type": "invalid_request_error"}})), strict=True)

    with pytest.raises(LLMError) as caught:
        client.chat([{"role": "user", "content": "PRIVATE_FULL_PROMPT"}])

    message = str(caught.value)
    assert secret not in message
    assert "sk-test-000000" not in message
    assert "PRIVATE_FULL_PROMPT" not in message
    assert "<redacted>" in message
    assert len(message) <= 320
    assert caught.value.code == "LLM_REQUEST_FAILED"
    assert caught.value.retryable is False


def test_timeout_has_stable_structured_error_code():
    S.update({"llm": {"api_key": "sk-test-000000"}})

    def timeout(request):
        raise httpx.ReadTimeout("provider timeout", request=request)

    client = DeepSeekClient(transport=httpx.MockTransport(timeout), strict=True)
    with pytest.raises(LLMError) as caught:
        client.chat([])

    assert caught.value.code == "LLM_TIMEOUT"
    assert caught.value.retryable is True


def test_model_call_budget_is_enforced_and_reset_per_turn():
    S.update({"llm": {"api_key": "sk-test-000000", "max_calls_per_turn": 1}})
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"choices": [{"message": {
            "content": "done", "tool_calls": [{"id": "c1", "type": "function", "function": {
                "name": "finish", "arguments": "{}"}}]}}]})

    engine = create_decision_engine(
        "deepseek", transport=httpx.MockTransport(handler), strict=True)
    state = {"parsed": {"sub_queries": []}, "calls": [], "error_feedback": []}

    engine.decide(state, [])
    with pytest.raises(LLMError) as caught:
        engine.decide(state, [])

    assert caught.value.code == "LLM_CALL_BUDGET_EXCEEDED"
    assert len(requests) == 1

    engine.begin_turn()
    engine.decide(state, [])
    assert len(requests) == 2


def test_run_turn_threads_mode_and_strict_policy_without_mutating_config(monkeypatch):
    from app.adapters.outbound.llm.mock import MockDecisionEngine
    from app.application.agents import orchestrator as graph

    calls = []

    class Engine(MockDecisionEngine):
        def __init__(self):
            super().__init__()
            self.turns = 0

        def begin_turn(self):
            self.turns += 1

    engine = Engine()

    def fake_get_client(mode, strict=False):
        calls.append((mode, strict))
        return engine

    monkeypatch.setattr(graph.llm_mod, "get_client", fake_get_client)
    monkeypatch.setattr(graph, "_drive", lambda inp, session_id, on_event=None: {"mode": inp["mode"]})
    graph.reset_graph()
    before = copy.deepcopy(S.get())

    result = graph.run_turn("secure-mode", "u_li", "退票", mode="deepseek", strict=True)

    assert result["mode"] == "deepseek"
    assert calls == [("deepseek", True)]
    assert engine.turns == 1
    assert S.get() == before
    graph.reset_graph()


def test_concurrent_turn_cannot_replace_engine_strictness_or_budget(monkeypatch):
    from app.adapters.outbound.llm.deepseek import DeepSeekDecisionEngine
    from app.adapters.outbound.llm.mock import MockDecisionEngine
    from app.application.agents import orchestrator as graph

    deep = DeepSeekDecisionEngine(
        SimpleNamespace(usage={"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}),
        strict=True, max_calls_per_turn=2)
    mock = MockDecisionEngine()
    monkeypatch.setattr(graph.llm_mod, "get_client",
                        lambda mode, strict=False: deep if mode == "deepseek" else mock)

    gate = threading.Lock()
    deep_started = threading.Event()
    mock_lock_attempt = threading.Event()
    release_deep = threading.Event()

    class TrackingLock:
        def __enter__(self):
            if threading.current_thread().name == "mock-turn":
                mock_lock_attempt.set()
            gate.acquire()

        def __exit__(self, *args):
            gate.release()

    monkeypatch.setattr(graph.memory, "session_lock", lambda session_id: TrackingLock())
    observed = {}

    def fake_drive(inp, session_id, on_event=None):
        if inp["mode"] == "deepseek":
            deep_started.set()
            assert release_deep.wait(timeout=2)
            engine = graph._clients[session_id]
            if hasattr(engine, "_charge"):
                engine._charge()
            observed["deep"] = {"mode": engine.mode, "strict": getattr(engine, "strict", None),
                                "calls": getattr(engine, "_turn_calls", None)}
        else:
            observed["mock"] = graph._clients[session_id].mode
        return {}

    monkeypatch.setattr(graph, "_drive", fake_drive)
    graph.reset_graph()
    errors = []

    def invoke(mode, strict):
        try:
            graph.run_turn("shared-session", "u_li", "退票", mode=mode, strict=strict)
        except Exception as exc:  # pragma: no cover - assertion below reports thread failures
            errors.append(exc)

    deep_thread = threading.Thread(target=invoke, args=("deepseek", True), name="deep-turn")
    mock_thread = threading.Thread(target=invoke, args=("mock", False), name="mock-turn")
    deep_thread.start()
    assert deep_started.wait(timeout=2)
    mock_thread.start()
    try:
        assert mock_lock_attempt.wait(timeout=2)
    finally:
        release_deep.set()
    deep_thread.join(timeout=2)
    mock_thread.join(timeout=2)

    assert not deep_thread.is_alive() and not mock_thread.is_alive()
    assert errors == []
    assert observed["deep"] == {"mode": "deepseek", "strict": True, "calls": 1}
    assert observed["mock"] == "mock"
    graph.reset_graph()


def test_resume_reuses_checkpoint_mode_after_restart(monkeypatch):
    from app.adapters.outbound.llm.mock import MockDecisionEngine
    from app.application.agents import orchestrator as graph

    calls = []
    engine = MockDecisionEngine()
    monkeypatch.setattr(graph.llm_mod, "get_client",
                        lambda mode, strict=False: calls.append((mode, strict)) or engine)
    monkeypatch.setattr(graph, "pending_interrupt", lambda session_id: None)
    monkeypatch.setattr(graph, "_drive", lambda inp, session_id, on_event=None: {})
    monkeypatch.setattr(graph, "get_graph", lambda: SimpleNamespace(
        get_state=lambda cfg: SimpleNamespace(values={"mode": "deepseek"})))
    graph.reset_graph()

    graph.resume("secure-resume", {"value": "星期四"}, mode="mock", strict=True)

    assert calls == [("deepseek", True)]
    graph.reset_graph()


def test_run_turn_stores_effective_strict_policy_in_checkpoint_input(monkeypatch):
    from app.adapters.outbound.llm.mock import MockDecisionEngine
    from app.application.agents import orchestrator as graph

    monkeypatch.setattr(graph.llm_mod, "get_client", lambda mode, strict=False: MockDecisionEngine())
    monkeypatch.setattr(graph, "_drive",
                        lambda inp, session_id, on_event=None: {"strict": inp.get("strict")})
    graph.reset_graph()

    result = graph.run_turn("strict-checkpoint", "u_li", "退票", mode="deepseek", strict=True)

    assert result["strict"] is True
    graph.reset_graph()


def test_deepseek_checkpoint_stays_strict_when_resumed_as_aeroagent_mock(monkeypatch):
    from app.adapters.outbound.llm.mock import MockDecisionEngine
    from app.application.agents import orchestrator as graph

    calls = []
    monkeypatch.setattr(graph.llm_mod, "get_client",
                        lambda mode, strict=False: calls.append((mode, strict)) or MockDecisionEngine())
    monkeypatch.setattr(graph, "pending_interrupt", lambda session_id: None)
    monkeypatch.setattr(graph, "_drive", lambda inp, session_id, on_event=None: {})
    monkeypatch.setattr(graph, "get_graph", lambda: SimpleNamespace(
        get_state=lambda cfg: SimpleNamespace(values={"mode": "deepseek", "strict": True})))
    graph.reset_graph()

    # 模拟重启后宿主以 aeroagent-mock 发起恢复；检查点策略必须优先于当前模型档。
    graph.resume("strict-resume", {"value": "继续"}, mode="mock", strict=False)

    assert calls == [("deepseek", True)]
    graph.reset_graph()


def test_provider_failure_is_retryable_without_result_unknown(monkeypatch):
    from app.application.cases import service

    case = SimpleNamespace(status="OPEN", updated_at=None, result={})
    events = []

    class Agent:
        def run_turn(self, *args, **kwargs):
            raise LLMError("provider unavailable", code="LLM_REQUEST_FAILED", retryable=True)

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key): return case
        async def commit(self): pass

    async def async_noop(*args): return None
    async def record(*args): events.append(args)

    monkeypatch.setattr(service, "_main_agent", Agent())
    monkeypatch.setattr(service, "SessionFactory", Session)
    monkeypatch.setattr(service, "sync_agent_projection", async_noop)
    monkeypatch.setattr(service, "record_case_event", record)

    with pytest.raises(LLMError) as caught:
        asyncio.run(service.run_case_turn({
            "case_id": "case-provider", "user_id": "u_li", "session_id": "session-provider",
            "message": "退票", "mode": "deepseek", "strict": True}))

    assert caught.value.retryable is True
    assert caught.value.case_id == "case-provider"
    assert case.status == "OPEN"
    assert case.result["error"] == {"code": "LLM_REQUEST_FAILED", "retryable": True}
    assert events[-1][1] == "case.failed"


def test_case_service_threads_mode_for_new_and_resumed_turns(monkeypatch):
    from app.application.cases import service

    calls = []

    class Agent:
        async def noop(self):
            return None

        def run_turn(self, *args, **kwargs):
            calls.append(("run", kwargs))
            return {"trace": []}

        def resume(self, *args, **kwargs):
            calls.append(("resume", kwargs))
            return {"trace": []}

    case = SimpleNamespace(status="OPEN", updated_at=None, result={}, order_id=None,
                           current_quote_id=None)
    agent = Agent()

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key): return case
        async def commit(self): pass

    async def async_noop(*args):
        return None

    monkeypatch.setattr(service, "_main_agent", agent)
    monkeypatch.setattr(service, "SessionFactory", Session)
    monkeypatch.setattr(service, "sync_agent_projection", async_noop)
    monkeypatch.setattr(service, "persist_agent_profile", async_noop)
    monkeypatch.setattr(service, "record_case_event", async_noop)

    base = {"case_id": "case-mode", "user_id": "u_li", "session_id": "session-mode",
            "message": "退票", "mode": "deepseek", "strict": True}
    asyncio.run(service.run_case_turn(base))
    asyncio.run(service.run_case_turn({**base, "resume_payload": {"value": "继续"}}))

    assert [name for name, _ in calls] == ["run", "resume"]
    assert all(kwargs["mode"] == "deepseek" and kwargs["strict"] is True
               for _, kwargs in calls)
