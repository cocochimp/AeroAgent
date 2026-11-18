"""面向对话的主服务 Agent，只识别意图并准备受限交接。"""
from app.application.agents import understanding as query
from opentelemetry import trace

_tracer = trace.get_tracer("air-ticket.agent.main")


class MainServiceAgent:
    """负责对话和意图解析；没有任何写侧工具权限。"""

    def understand(self, message: str, context: dict, llm=None):
        """识别乘客意图并追踪理解决策；只输出结构化理解和追问，不接触写侧工具。"""
        with _tracer.start_as_current_span("agent.main.understand") as span:
            result = query.understand(message, context, llm)
            span.set_attribute("agent.intent_count", len(result.sub_queries))
            span.set_attribute("agent.needs_clarification", bool(result.clarify))
            return result

    def can_call(self, tool_name: str) -> bool:
        """始终拒绝工具调用；主服务 Agent 只负责对话与理解，权限边界由代码保证。"""
        return False

    def run_turn(self, session_id: str, user_id: str, message: str, *, order_id: str | None = None,
                 mode=None, strict=False, on_event=None):
        """把会话交给 LangGraph 编排器；保持主 Agent 门面与现有图驱动解耦。"""
        from app.application.agents import orchestrator as legacy_graph
        return legacy_graph.run_turn(session_id, user_id, message, order_id=order_id,
                                     mode=mode, strict=strict, on_event=on_event)

    def resume(self, session_id: str, payload: dict, *, mode=None, strict=False, on_event=None):
        """恢复编排器中的中断会话；用于追问和交易确认后的继续执行。"""
        from app.application.agents import orchestrator as legacy_graph
        return legacy_graph.resume(session_id, payload, mode=mode, strict=strict, on_event=on_event)
