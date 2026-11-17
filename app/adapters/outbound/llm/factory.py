"""构建配置指定的决策引擎；零密钥环境默认使用 mock。"""

from app import config as S
from app.application.agents.llm import DeepSeekClient, LLMNotConfigured
from .deepseek import DeepSeekDecisionEngine
from .mock import MockDecisionEngine


def create_decision_engine(mode: str | None = None, *, transport=None, client=None):
    """按配置创建离线或 DeepSeek 决策引擎；已注入客户端优先复用，在线模式缺少密钥时立即失败。"""
    if client is not None:
        return client if hasattr(client, "decide") else DeepSeekDecisionEngine(client)
    mode = mode or S.get()["mode"]
    if mode in {"mock", "offline"}:       # offline 是评测与旧配置兼容别名
        return MockDecisionEngine()
    if mode == "deepseek":
        if not S.get()["llm"]["api_key"]:
            raise LLMNotConfigured("DeepSeek 模式需要先在配置中心填写 API Key")
        return DeepSeekDecisionEngine(DeepSeekClient(transport=transport))
    raise ValueError(f"不支持的 LLM 决策模式：{mode}")
