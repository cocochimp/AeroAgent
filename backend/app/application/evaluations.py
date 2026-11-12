"""Evaluation case-set snapshots and report helpers."""
from __future__ import annotations

from copy import deepcopy


def select_case_snapshot(cases: list[dict], case_ids: list[str] | None = None) -> list[dict]:
    """Validate requested IDs and return detached cases in source order."""
    ids = [case.get("id") for case in cases if isinstance(case, dict)]
    if len(ids) != len(cases) or any(not isinstance(case_id, str) or not case_id for case_id in ids):
        raise ValueError("评测用例结构无效")
    if len(ids) != len(set(ids)):
        raise ValueError("评测用例 ID 重复")
    if case_ids is None:
        return deepcopy(cases)
    unknown = sorted(set(case_ids) - set(ids))
    if unknown:
        raise ValueError(f"未知用例：{', '.join(unknown)}")
    selected = set(case_ids)
    return deepcopy([case for case in cases if case["id"] in selected])


def public_progress(progress: dict) -> dict:
    """Hide the immutable case snapshot from run-list progress responses."""
    return {key: value for key, value in progress.items()
            if key not in {"case_snapshot", "selected_case_ids"}}
