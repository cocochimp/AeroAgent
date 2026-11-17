"""带策略版本的平台权益决策。"""
from dataclasses import dataclass

from .tier import MembershipTier


@dataclass(frozen=True, slots=True)
class BenefitDecision:
    """保存带策略版本的权益决策；平台补贴不能为负且必须可追溯。"""
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
