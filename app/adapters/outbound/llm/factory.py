"""构建配置指定的决策引擎；零密钥环境默认使用 mock。"""

from app import config as S
from app.application.agents.llm import DeepSeekClient, LLMNotConfigured
from .deepseek import DeepSeekDecisionEngine
from .mock import MockDecisionEngine


def create_decision_engine(mode: str | None = None, *, transport=None, client=None, strict=False):
    """按配置创建离线或 DeepSeek 决策引擎；严格模式绝不把供应商错误替换为规则答案。"""
    budget = S.get()["llm"]["max_calls_per_turn"]
    if client is not None:
        return client if hasattr(client, "decide") else DeepSeekDecisionEngine(
            client, strict=strict, max_calls_per_turn=budget)
    mode = mode or S.get()["mode"]
    if mode in {"mock", "offline"}:       # offline 是评测与旧配置兼容别名
        return MockDecisionEngine()
    if mode == "deepseek":
        if not S.get()["llm"]["api_key"]:
            raise LLMNotConfigured("DeepSeek 模式需要先在配置中心填写 API Key")
        return DeepSeekDecisionEngine(DeepSeekClient(transport=transport, strict=strict),
                                      strict=strict, max_calls_per_turn=budget)
    raise ValueError(f"不支持的 LLM 决策模式：{mode}")
