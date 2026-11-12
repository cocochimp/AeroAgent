"""Idempotent supplier operation record."""
from dataclasses import dataclass
from enum import StrEnum
from datetime import datetime


class OperationStatus(StrEnum):
    PENDING = "PENDING"
    SUBMITTED = "SUBMITTED"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    RESULT_UNKNOWN = "RESULT_UNKNOWN"


@dataclass(frozen=True, slots=True)
class Operation:
    operation_id: str
    idempotency_key: str
    case_id: str
    quote_id: str
    order_id: str
    action: str
    amount: int
    status: OperationStatus
    created_at: datetime
