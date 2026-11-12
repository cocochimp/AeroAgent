"""A versioned platform benefit decision."""
from dataclasses import dataclass

from .tier import MembershipTier


@dataclass(frozen=True, slots=True)
class BenefitDecision:
    eligible: bool
    tier: MembershipTier
    platform_credit: int
    policy_version: str
    reason: str

    def __post_init__(self) -> None:
        if self.platform_credit < 0:
            raise ValueError("平台权益金额不能为负数")
        if not self.policy_version.strip():
            raise ValueError("权益决策必须记录策略版本")
