"""只读方案 Agent，负责收集证据并提出退改建议。"""
from app.application.agents import planning as planner
from opentelemetry import trace

_tracer = trace.get_tracer("air-ticket.agent.solution")


class ServicingAdvisorAgent:
    """聚合只读证据并生成退改建议；工具白名单排除任何出票和退票能力。"""
    READ_ONLY_TOOLS = frozenset({"tool_flight_status", "tool_rule_retrieve", "tool_recalc_fee", "finish"})

    def decide(self, state: dict, llm=None) -> dict:
        """规划下一步只读动作并记录链路；模型决策失败由规划器负责规则降级。"""
        with _tracer.start_as_current_span("agent.solution.decide") as span:
            decision = planner.decide(state, llm)
            span.set_attribute("agent.action", decision.get("action", "unknown"))
            return decision

    def can_call(self, tool_name: str) -> bool:
        """判断工具是否在只读白名单内；未列出的写侧工具一律拒绝。"""
        return tool_name in self.READ_ONLY_TOOLS
