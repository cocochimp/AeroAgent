import pytest
from app.adapters.outbound.sqlite import data
from app.application.agents import llm, orchestrator as graph
from app.application.agents.models import SubQuery

D = "20260926"
O1 = f"ORD{D}001"
FEE = lambda date: {"order_id": O1, "action": "CHANGE", "target_date": date}


@pytest.fixture(autouse=True)
def _fresh():
    data.init()
    graph.reset_graph()
    yield
    graph.reset_graph()


def act(tool, args=None, thought="..."):
    return {"thought": thought, "action": tool, "args": args or {}}


class NoPaidLLM(llm.FakeLLM):
    def __init__(self):
        super().__init__()
        self.calls = []

    def parse_intents(self, *args):
        self.calls.append("parse_intents")
        return None

    def react(self, *args, **kwargs):
        self.calls.append("react")
        return act("finish")


class EmptyIntentLLM(llm.FakeLLM):
    def __init__(self):
        super().__init__(react=[act("tool_rule_retrieve", {"query": "退票规则"}), act("finish")])
        self.parse_questions = []

    def parse_intents(self, question, *args):
        self.parse_questions.append(question)
        return []


class InventedDateLLM(NoPaidLLM):
    def __init__(self, target_date):
        super().__init__()
        self.target_date = target_date

    def parse_intents(self, *args):
        self.calls.append("parse_intents")
        return [SubQuery(intent="CHANGE", text="改到后天", target_date=self.target_date)]

    def react(self, *args, **kwargs):
        self.calls.append("react")
        return act("tool_recalc_fee", FEE(self.target_date))


def test_schema_error_feedback_then_success():
    fake = llm.FakeLLM(react=[
        act("tool_rule_retrieve", {"query": "折扣票改签", "airline": "MU", "fare_product": "Y_DISCOUNT"}),
        act("tool_recalc_fee", FEE("后天")),                  # 相对日期 → TYPE 错误
        act("tool_recalc_fee", FEE("2026-09-28")),            # 带着反馈修正
        act("finish"),
    ])
    res = graph.run_turn("l1", "u_zhang", "改到后天", order_id=O1, mode="deepseek", client=fake)
    assert res["outcome"] == "ANSWER"
    sv = [e["status"] for e in res["trace"] if e["node"] == "schema_validate"]
    assert sv == ["ok", "error", "ok"]


def test_gate_blocks_fee_before_rules():
    fake = llm.FakeLLM(react=[
        act("tool_recalc_fee", FEE("2026-09-28")),            # 跳步：没查规则就算钱
        act("tool_rule_retrieve", {"query": "折扣票改签", "airline": "MU"}),
        act("tool_recalc_fee", FEE("2026-09-28")),
        act("finish"),
    ])
    res = graph.run_turn("l2", "u_zhang", "改到后天", order_id=O1, mode="deepseek", client=fake)
    gates = [e["status"] for e in res["trace"] if e["node"] == "checkpoint_gate"]
    assert gates[0] == "blocked" and res["outcome"] == "ANSWER"


def test_wrong_amount_text_triggers_retry_then_passes():
    steps = [act("tool_rule_retrieve", {"query": "折扣票改签", "airline": "MU", "fare_product": "Y_DISCOUNT"}),
             act("tool_recalc_fee", FEE("2026-09-28")), act("finish")]
    fake = llm.FakeLLM(react=steps, scheme_texts=["改签只需支付1元。", None])
    res = graph.run_turn("l3", "u_zhang", "改到后天", order_id=O1, mode="deepseek", client=fake)
    ns = [e["node"] for e in res["trace"]]
    assert "retry_node" in ns and res["outcome"] == "ANSWER"
    assert res["final"]["text"] != "改签只需支付1元。"


def test_llm_failure_falls_back_to_rules():
    fake = llm.FakeLLM(react=[llm.LLMError("timeout")] * 10)
    res = graph.run_turn("l4", "u_zhang", "改到后天", order_id=O1, mode="deepseek", client=fake)
    assert res["outcome"] == "ANSWER"
    assert all(e["output"]["source"] == "fallback" for e in res["trace"] if e["node"] == "agent_node")


def test_round_limit_goes_human():
    fake = llm.FakeLLM(react=[act("tool_flight_status", {"flight_no": "MU5101", "date": "2026-09-28"})] * 10)
    res = graph.run_turn("l5", "u_zhang", "改到后天", order_id=O1, mode="deepseek", client=fake)
    assert res["outcome"] == "HUMAN"


def test_past_iso_clarifies_before_paid_model_or_tool_calls():
    no_paid = NoPaidLLM()

    res = graph.run_turn("past-iso", "u_zhang", "改到2026-09-26",
                         order_id=O1, mode="deepseek", client=no_paid)

    assert res["interrupt"]["kind"] == "clarify"
    assert res["interrupt"]["field"] == "target_date"
    assert no_paid.calls == []
    assert not [e for e in res["trace"] if e["node"] in {"agent_node", "tool_exec"}]


def test_forced_past_iso_clarifies_before_paid_model_or_tool_calls_on_resume():
    initial = graph.run_turn("forced-past-iso", "u_zhang", "改到下个月初", order_id=O1, mode="mock")
    assert initial["interrupt"]["kind"] == "clarify"
    no_paid = NoPaidLLM()

    res = graph.resume("forced-past-iso", {"value": "2026-09-26"}, client=no_paid, strict=True)

    assert res["interrupt"]["kind"] == "clarify"
    assert res["interrupt"]["field"] == "target_date"
    assert no_paid.calls == []
    assert not [e for e in res["trace"] if e["node"] in {"agent_node", "tool_exec"}]


@pytest.mark.parametrize("target_date", ["2026-09-26", "2026-09-25"])
def test_provider_invented_rejected_date_clarifies_before_react_or_tools(monkeypatch, target_date):
    fake = InventedDateLLM(target_date)
    tool_calls = []

    def spy_tool(*args):
        tool_calls.append(args)
        return {"ok": False, "kind": "ENGINE", "error": {"code": "STOP", "message": "stop"}}

    monkeypatch.setattr(graph.tools, "run_tool", spy_tool)

    # 原始输入是未来的“后天”；过去/今天日期只由模型返回，模拟模型编造。
    res = graph.run_turn(f"invented-{target_date}", "u_zhang", "改到后天",
                         order_id=O1, mode="deepseek", client=fake)

    assert res["interrupt"]["kind"] == "clarify"
    assert res["interrupt"]["field"] == "target_date"
    assert fake.calls == ["parse_intents"]
    assert tool_calls == []
    assert not [e for e in res["trace"] if e["node"] in {"agent_node", "tool_exec"}]


def test_natural_language_intent_clarification_resume_reaches_planning():
    greeting = "你好，请用一句中文介绍你自己。只介绍，不要办理任何业务。"
    answer = "了解规则。请只说明当前客票的退票规则，不要生成报价，也不要办理。"
    fake = EmptyIntentLLM()
    initial = graph.run_turn("natural-intent-resume", "u_zhang", greeting,
                             mode="deepseek", client=fake)
    assert initial["interrupt"]["field"] == "intent"

    resumed = graph.resume("natural-intent-resume", {"value": answer})

    assert fake.parse_questions == [greeting, greeting]
    assert resumed["parsed"]["intents"] == ["POLICY"]
    assert resumed["parsed"]["sub_queries"][0]["text"] == answer
    assert resumed["parsed"]["clarify"] is None
    assert any(e["node"] == "agent_node" for e in resumed["trace"])


def test_ambiguous_natural_language_intent_clarification_asks_again():
    fake = EmptyIntentLLM()
    initial = graph.run_turn("ambiguous-intent-resume", "u_zhang", "你好，只介绍你自己。",
                             mode="deepseek", client=fake)
    assert initial["interrupt"]["field"] == "intent"

    resumed = graph.resume("ambiguous-intent-resume", {"value": "随便吧，你看着办。"})

    assert resumed["interrupt"]["kind"] == "clarify"
    assert resumed["interrupt"]["field"] == "intent"
    assert resumed["parsed"]["intents"] == []
    assert not [e for e in resumed["trace"] if e["node"] == "agent_node"]
