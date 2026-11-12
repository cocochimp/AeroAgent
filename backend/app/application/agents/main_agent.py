"""Conversation-facing Agent: identify intent and prepare a bounded handoff."""
from air_agent import query
from opentelemetry import trace

_tracer = trace.get_tracer("air-ticket.agent.main")


class MainServiceAgent:
    """Owns dialogue and intent resolution; it has no write-side tools."""

    def understand(self, message: str, context: dict, llm=None):
        with _tracer.start_as_current_span("agent.main.understand") as span:
            result = query.understand(message, context, llm)
            span.set_attribute("agent.intent_count", len(result.sub_queries))
            span.set_attribute("agent.needs_clarification", bool(result.clarify))
            return result

    def can_call(self, tool_name: str) -> bool:
        return False

    def run_turn(self, session_id: str, user_id: str, message: str, *, order_id: str | None = None,
                 on_event=None):
        from air_agent import graph as legacy_graph
        return legacy_graph.run_turn(session_id, user_id, message, order_id=order_id, on_event=on_event)

    def resume(self, session_id: str, payload: dict, *, on_event=None):
        from air_agent import graph as legacy_graph
        return legacy_graph.resume(session_id, payload, on_event=on_event)
