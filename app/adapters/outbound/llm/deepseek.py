"""基于现有 DeepSeek HTTP 客户端的决策引擎。"""

from app.application.agents.llm import LLMError


def _error(exc: LLMError) -> dict:
    """保留客户端已归一化的错误码和重试策略，不从错误文本二次猜测。"""
    return {"code": exc.code, "message": str(exc), "retryable": exc.retryable}


class DeepSeekDecisionEngine:
    """把 DeepSeek 客户端适配为统一决策端口；模型失败时自动回退规则计划。"""
    mode = "deepseek"

    def __init__(self, client, *, strict=False, max_calls_per_turn=None):
        self.client = client
        self.strict = strict
        self.max_calls_per_turn = max_calls_per_turn
        self._turn_calls = 0

    def begin_turn(self):
        """重置单轮付费调用预算；会话恢复时也必须重新计数。"""
        self._turn_calls = 0

    def _charge(self):
        if self.max_calls_per_turn is not None and self._turn_calls >= self.max_calls_per_turn:
            raise LLMError("本轮模型调用次数已达上限，请另起一轮后重试",
                           code="LLM_CALL_BUDGET_EXCEEDED", retryable=False)
        self._turn_calls += 1

    @property
    def usage(self):
        """透传底层客户端 Token 用量；让编排器统一记录观测数据。"""
        return self.client.usage

    def decide(self, state: dict, messages: list[dict]) -> dict:
        """调用模型生成 ReAct 动作；严格模式抛错，兼容模式保留可见的规则降级。"""
        self._charge()
        try:
            action = self.client.react(messages)
            return {**action, "source": "llm", "usage": dict(self.usage), "error": None}
        except LLMError as exc:
            if self.strict:
                raise
            from app.application.agents.planning import rule_decide
            return {
                **rule_decide(state), "source": "fallback", "fallback_reason": str(exc),
                "usage": dict(self.usage), "error": _error(exc),
            }

    def parse_intents(self, *args):
        """转发意图拆解调用；降级策略由客户端实现。"""
        self._charge()
        return self.client.parse_intents(*args)

    def summarize(self, *args):
        """转发对话摘要调用；失败结果由记忆模块处理。"""
        self._charge()
        return self.client.summarize(*args)

    def write_scheme(self, *args):
        """转发方案润色调用；金额保护由生成器统一执行。"""
        self._charge()
        return self.client.write_scheme(*args)

    def fact_check(self, *args):
        """转发事实核查调用；本地确定性校验始终保留。"""
        self._charge()
        return self.client.fact_check(*args)
