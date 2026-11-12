"""A customer service case and guarded state transition."""
from dataclasses import dataclass, replace
from datetime import datetime

from .state import CaseStatus, TRANSITIONS


@dataclass(frozen=True, slots=True)
class ServiceCase:
    case_id: str
    user_id: str
    status: CaseStatus
    created_at: datetime
    updated_at: datetime
    order_id: str | None = None
    active_quote_id: str | None = None
    intent: str | None = None

    def transition(self, target: CaseStatus, at: datetime, **changes) -> "ServiceCase":
        if target not in TRANSITIONS[self.status]:
            raise ValueError(f"不允许案件状态从 {self.status} 变更为 {target}")
        return replace(self, status=target, updated_at=at, **changes)
