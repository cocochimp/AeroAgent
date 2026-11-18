import asyncio
import copy
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
