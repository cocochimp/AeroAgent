"""支持幂等重放的供应商办理记录。"""
from dataclasses import dataclass
from enum import StrEnum
from datetime import datetime


class OperationStatus(StrEnum):
    """枚举供应商办理状态；结果未知与明确失败分开，防止超时后自动重试。"""
    PENDING = "PENDING"
    SUBMITTED = "SUBMITTED"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    RESULT_UNKNOWN = "RESULT_UNKNOWN"


@dataclass(frozen=True, slots=True)
class Operation:
    """保存一次供应商办理的不可变核心记录；幂等键贯穿提交和结果查询。"""
    operation_id: str
    idempotency_key: str
    case_id: str
    quote_id: str
    order_id: str
    action: str
    amount: int
    status: OperationStatus
    created_at: datetime
