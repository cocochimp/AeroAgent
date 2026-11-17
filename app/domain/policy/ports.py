"""政策查询端口；检索负责证据排序，领域政策负责资格判断。"""
from typing import Protocol


class PolicyRepository(Protocol):
    """定义政策规则只读端口；检索负责找证据，领域规则负责判断。"""
    async def get_rule(self, rule_id: str) -> dict | None:
        """按规则标识读取原文；用于核对计价依据和引用。"""
        ...
    async def list_rules(self, *, airline: str | None = None, cabin: str | None = None,
                         fare_product: str | None = None, scenario: str | None = None) -> list[dict]:
        """按航司、舱位和场景筛选规则；空条件表示不限制该维度。"""
        ...
