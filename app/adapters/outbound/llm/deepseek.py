"""基于现有 DeepSeek HTTP 客户端的决策引擎。"""

from app.application.agents.llm import LLMError


def _error(exc: LLMError) -> dict:
    message = str(exc)
    timeout = "timeout" in message.lower()
    return {
        "code": "LLM_TIMEOUT" if timeout else "LLM_REQUEST_FAILED",
        "message": message,
        "retryable": timeout or any(name in message for name in (
            "ConnectError", "ReadError", "WriteError", "RemoteProtocolError", "HTTPStatusError",
        )),
    }


class DeepSeekDecisionEngine:
    """把 DeepSeek 客户端适配为统一决策端口；模型失败时自动回退规则计划。"""
    mode = "deepseek"

    def __init__(self, client):
        self.client = client

    @property
    def usage(self):
        """透传底层客户端 Token 用量；让编排器统一记录观测数据。"""
        return self.client.usage

    def decide(self, state: dict, messages: list[dict]) -> dict:
        """调用模型生成 ReAct 动作；仅捕获模型错误并保留降级原因和可重试标记。"""
        try:
            action = self.client.react(messages)
            return {**action, "source": "llm", "usage": dict(self.usage), "error": None}
        except LLMError as exc:
            from app.application.agents.planning import rule_decide
            return {
                **rule_decide(state), "source": "fallback", "fallback_reason": str(exc),
                "usage": dict(self.usage), "error": _error(exc),
            }

    def parse_intents(self, *args):
        """转发意图拆解调用；降级策略由客户端实现。"""
        return self.client.parse_intents(*args)

    def summarize(self, *args):
        """转发对话摘要调用；失败结果由记忆模块处理。"""
        return self.client.summarize(*args)

    def write_scheme(self, *args):
        """转发方案润色调用；金额保护由生成器统一执行。"""
        return self.client.write_scheme(*args)

    def fact_check(self, *args):
        """转发事实核查调用；本地确定性校验始终保留。"""
        return self.client.fact_check(*args)
