import httpx
import pytest

from app import config as S
from app.adapters.outbound.sqlite import data
from app.application.agents import orchestrator as graph
from app.application.agents import planning as planner
from app.application.agents import understanding as query
from app.application.agents.llm import DeepSeekClient, LLMError, LLMNotConfigured
from app.adapters.outbound.llm.factory import create_decision_engine


def _state():
    data.init()
    parsed = query.understand("改到大后天", {
        "user_id": "u_zhang", "selected_order_id": "ORD20260926001", "order_stack": [],
        "last_intent": None, "forced_date": None, "forced_intent": None,
    })
    return {"parsed": parsed.model_dump(), "sub_idx": 0, "calls": [], "error_feedback": []}


def _deepseek_transport():
    def handler(request):
        return httpx.Response(200, json={
            "choices": [{"message": {"content": "先确认航班状态", "tool_calls": [{
                "id": "call-1", "type": "function", "function": {
                    "name": "tool_flight_status",
                    "arguments": '{"flight_no":"MU5101","date":"2026-09-28"}',
                },
            }]}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4},
        })
    return httpx.MockTransport(handler)


@pytest.mark.parametrize("mode", ["mock", "deepseek"])
def test_decision_engine_contract(mode):
    S.update({"llm": {"api_key": "sk-test-000000"}})
    engine = create_decision_engine(mode, transport=_deepseek_transport() if mode == "deepseek" else None)
    state = _state()

    result = engine.decide(state, planner.llm_messages(state))

    assert result["action"] == "tool_flight_status"
    assert result["args"] == {"flight_no": "MU5101", "date": "2026-09-28"}
    assert result["source"] == ("rule" if mode == "mock" else "llm")
    assert set(result["usage"]) == {"calls", "prompt_tokens", "completion_tokens"}
    assert result["error"] is None


def test_default_decision_engine_is_explicit_mock():
    assert create_decision_engine().mode == "mock"


def test_deepseek_factory_requires_key():
    with pytest.raises(LLMNotConfigured):
        create_decision_engine("deepseek")


def test_deepseek_failure_returns_structured_fallback_error():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    transport = httpx.MockTransport(lambda request: httpx.Response(503, json={"error": "unavailable"}))
    engine = create_decision_engine("deepseek", transport=transport)

    result = engine.decide(_state(), [])

    assert result["source"] == "fallback"
    assert result["action"] == "tool_flight_status"
    assert set(result["error"]) == {"code", "message", "retryable"}
    assert result["error"]["message"]
    assert result["usage"]["calls"] == 0


def test_strict_deepseek_failure_is_explicit_and_retryable():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    transport = httpx.MockTransport(lambda request: httpx.Response(503, json={"error": "unavailable"}))
    engine = create_decision_engine("deepseek", transport=transport, strict=True)

    with pytest.raises(LLMError) as caught:
        engine.decide(_state(), [])

    assert caught.value.code == "LLM_REQUEST_FAILED"
    assert caught.value.retryable is True


def test_deepseek_fallback_is_visible_in_agent_trace():
    S.update({"llm": {"api_key": "sk-test-000000"}})
    data.init()
    graph.reset_graph()
    client = DeepSeekClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(503, json={"error": "unavailable"})))
    try:
        result = graph.run_turn("adapter-fallback", "u_zhang", "改到大后天",
                                order_id="ORD20260926001", mode="deepseek", client=client)
        decisions = [event["output"] for event in result["trace"] if event["node"] == "agent_node"]
        assert decisions[0]["source"] == "fallback"
        assert decisions[0]["error"]["code"]
        assert any("回退规则" in event["note"] for event in result["trace"] if event["node"] == "agent_node")
    finally:
        graph.reset_graph()
