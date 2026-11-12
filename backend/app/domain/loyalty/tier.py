"""Membership tier definitions; actual entitlements remain policy data."""
from enum import IntEnum


class MembershipTier(IntEnum):
    REGULAR = 0
    SILVER = 1
    GOLD = 2
    BLACK_DIAMOND = 3

    @classmethod
    def from_label(cls, label: str) -> "MembershipTier":
        aliases = {"普通": cls.REGULAR, "普卡": cls.REGULAR, "银卡": cls.SILVER,
                   "金卡": cls.GOLD, "黑钻": cls.BLACK_DIAMOND}
        try:
            return aliases[label]
        except KeyError as exc:
            raise ValueError(f"未知会员等级：{label}") from exc
