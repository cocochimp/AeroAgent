"""不可变价格方案和确认快照。"""
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Quote:
    """保存不可变报价和确认快照；确认只产生新实例，避免历史证据被原地改写。"""
    quote_id: str
    case_id: str
    order_id: str
    action: str
    amount: int
    currency: str
    created_at: datetime
    expires_at: datetime
    policy_version: str
    benefit_version: str
    details: tuple[tuple[str, int], ...] = ()
    confirmed_at: datetime | None = None
    confirmation_id: str | None = None

    @property
    def is_confirmed(self) -> bool:
        """判断报价是否同时具备确认时间和确认号；两个字段缺一不可。"""
        return self.confirmed_at is not None and self.confirmation_id is not None

    def confirm(self, confirmation_id: str, at: datetime) -> "Quote":
        """返回带确认信息的新报价；同一确认号可重放，不同确认号不能覆盖原确认。"""
        if not confirmation_id.strip():
            raise ValueError("confirmation_id 不能为空")
        if self.is_confirmed:
            if self.confirmation_id == confirmation_id:
                return self
            raise ValueError("报价已由其他确认请求确认")
        return Quote(
            quote_id=self.quote_id,
            case_id=self.case_id,
            order_id=self.order_id,
            action=self.action,
            amount=self.amount,
            currency=self.currency,
            created_at=self.created_at,
            expires_at=self.expires_at,
            policy_version=self.policy_version,
            benefit_version=self.benefit_version,
            details=self.details,
            confirmed_at=at,
            confirmation_id=confirmation_id,
        )
