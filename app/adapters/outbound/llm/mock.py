"""面向零密钥运行的确定性规则决策引擎。"""


class MockDecisionEngine:
    """提供零密钥的确定性决策引擎；所有可选模型能力都降级到本地规则。"""
    mode = "mock"

    def __init__(self):
        self.usage = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}

    def decide(self, state: dict, messages: list[dict]) -> dict:
        """调用固定规则计划生成动作；附带空用量和统一错误结构。"""
        from app.application.agents.planning import rule_decide
        return {**rule_decide(state), "usage": dict(self.usage), "error": None}

    def parse_intents(self, *args):
        """返回空结果；意图拆解由本地规则完成。"""
        return None

    def summarize(self, *args):
        """返回空摘要；记忆模块改用本地截断摘要。"""
        return None

    def write_scheme(self, *args):
        """返回空方案；生成器保留确定性模板文案。"""
        return None

    def fact_check(self, *args):
        """返回空核查结果；校验器只执行本地事实检查。"""
        return None
