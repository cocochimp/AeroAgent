"""Immutable price proposal and confirmation snapshot."""
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class Quote:
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
        return self.confirmed_at is not None and self.confirmation_id is not None

    def confirm(self, confirmation_id: str, at: datetime) -> "Quote":
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
