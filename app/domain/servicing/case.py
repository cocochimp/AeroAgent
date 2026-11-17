"""客服案件及受状态机保护的转换。"""
from dataclasses import dataclass, replace
from datetime import datetime

from .state import CaseStatus, TRANSITIONS


@dataclass(frozen=True, slots=True)
class ServiceCase:
    """表示客服案件及其当前状态；所有状态变化必须经过受控转换。"""
    case_id: str
    user_id: str
    status: CaseStatus
    created_at: datetime
    updated_at: datetime
    order_id: str | None = None
    active_quote_id: str | None = None
    intent: str | None = None

    def transition(self, target: CaseStatus, at: datetime, **changes) -> "ServiceCase":
        """按状态机生成转换后的新案件；非法跳转立即拒绝且不修改原实例。"""
        if target not in TRANSITIONS[self.status]:
            raise ValueError(f"不允许案件状态从 {self.status} 变更为 {target}")
        return replace(self, status=target, updated_at=at, **changes)
