"""Read-only Agent that gathers evidence and proposes a servicing option."""
from air_agent import planner
from opentelemetry import trace

_tracer = trace.get_tracer("air-ticket.agent.solution")


class ServicingAdvisorAgent:
    READ_ONLY_TOOLS = frozenset({"tool_flight_status", "tool_rule_retrieve", "tool_recalc_fee", "finish"})

    def decide(self, state: dict, llm=None) -> dict:
        with _tracer.start_as_current_span("agent.solution.decide") as span:
            decision = planner.decide(state, llm)
            span.set_attribute("agent.action", decision.get("action", "unknown"))
            return decision

    def can_call(self, tool_name: str) -> bool:
        return tool_name in self.READ_ONLY_TOOLS
