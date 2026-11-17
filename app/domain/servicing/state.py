"""案件生命周期允许的状态与迁移表。"""
from enum import StrEnum


class CaseStatus(StrEnum):
    """定义案件生命周期状态；终态与结果未知状态具有不同后续路径。"""
    OPEN = "OPEN"
    NEEDS_INFORMATION = "NEEDS_INFORMATION"
    PROPOSED = "PROPOSED"
    WAITING_CONFIRMATION = "WAITING_CONFIRMATION"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    CANCELLED = "CANCELLED"
    HUMAN_REVIEW = "HUMAN_REVIEW"
    RESULT_UNKNOWN = "RESULT_UNKNOWN"


TRANSITIONS: dict[CaseStatus, frozenset[CaseStatus]] = {
    CaseStatus.OPEN: frozenset({CaseStatus.NEEDS_INFORMATION, CaseStatus.PROPOSED, CaseStatus.HUMAN_REVIEW, CaseStatus.CANCELLED}),
    CaseStatus.NEEDS_INFORMATION: frozenset({CaseStatus.OPEN, CaseStatus.PROPOSED, CaseStatus.HUMAN_REVIEW, CaseStatus.CANCELLED}),
    CaseStatus.PROPOSED: frozenset({CaseStatus.WAITING_CONFIRMATION, CaseStatus.HUMAN_REVIEW, CaseStatus.CANCELLED}),
    CaseStatus.WAITING_CONFIRMATION: frozenset({CaseStatus.PROCESSING, CaseStatus.PROPOSED, CaseStatus.CANCELLED, CaseStatus.HUMAN_REVIEW}),
    CaseStatus.PROCESSING: frozenset({CaseStatus.COMPLETED, CaseStatus.RESULT_UNKNOWN, CaseStatus.HUMAN_REVIEW}),
    CaseStatus.RESULT_UNKNOWN: frozenset({CaseStatus.COMPLETED, CaseStatus.HUMAN_REVIEW}),
    CaseStatus.COMPLETED: frozenset(),
    CaseStatus.CANCELLED: frozenset(),
    CaseStatus.HUMAN_REVIEW: frozenset({CaseStatus.PROPOSED, CaseStatus.PROCESSING, CaseStatus.CANCELLED, CaseStatus.COMPLETED}),
}
