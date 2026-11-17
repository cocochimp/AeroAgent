"""供应商金额和平台差额的不可变资金分录。"""
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class LedgerEntry:
    """表示不可变资金分录；记录航司金额和平台价格保护差额的记账依据。"""
    entry_id: str
    operation_id: str
    account: str
    amount: int
    currency: str
    reason: str
    created_at: datetime

    def __post_init__(self) -> None:
        if not self.entry_id or not self.operation_id:
            raise ValueError("LedgerEntry 必须绑定 entry_id 和 operation_id")
        if self.amount == 0:
            raise ValueError("LedgerEntry 金额不能为 0")
        if self.currency != "CNY":
            raise ValueError("当前教学项目只支持 CNY")
        if self.account not in {"CUSTOMER", "AIRLINE", "PLATFORM"}:
            raise ValueError(f"未知资金账户：{self.account}")
