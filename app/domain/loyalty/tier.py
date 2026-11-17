"""会员等级定义；实际权益仍由策略数据决定。"""
from enum import IntEnum


class MembershipTier(IntEnum):
    """定义有序会员等级；具体权益由策略数据决定而不是枚举本身。"""
    REGULAR = 0
    SILVER = 1
    GOLD = 2
    BLACK_DIAMOND = 3

    @classmethod
    def from_label(cls, label: str) -> "MembershipTier":
        """把中文会员标签转换为等级；未知标签显式报错。"""
        aliases = {"普通": cls.REGULAR, "普卡": cls.REGULAR, "银卡": cls.SILVER,
                   "金卡": cls.GOLD, "黑钻": cls.BLACK_DIAMOND}
        try:
            return aliases[label]
        except KeyError as exc:
            raise ValueError(f"未知会员等级：{label}") from exc
