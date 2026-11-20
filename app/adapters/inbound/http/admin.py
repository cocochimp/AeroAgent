"""仅管理员可用的政策、评测和运行配置 API。"""
import hashlib
import json
import os
import re
import uuid
import asyncio
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, select

from app.adapters.outbound import retrieval as agent_retrieval
from app import config as legacy_settings

from app.adapters.inbound.http.auth import Principal, require_admin
from app.adapters.outbound.persistence.database import SessionFactory
from app.adapters.outbound.persistence.models import (
    AuditRecord,
    EvaluationCaseSetRecord,
    EvaluationRunRecord,
    OutboxRecord,
    RuleRecord,
)
from app.adapters.outbound.sqlite.runtime_projection import sync_rules_to_agent_index
from app.application.cases.service import utcnow
from app.application.evaluations import public_progress, select_case_snapshot

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])
ID_PATTERN = re.compile(r"^[\w-]{1,64}$")
SCENARIOS = {"VOLUNTARY_CHANGE", "VOLUNTARY_REFUND", "CANCEL", "DELAY", "NO_SHOW", "FARE_DIFF"}
EVAL_CASES = Path(__file__).resolve().parents[4] / "eval" / "gold_cases.json"


class StrictModel(BaseModel):
    """禁止管理接口请求携带未知字段；避免配置或规则被静默写入意外属性。"""
    model_config = ConfigDict(extra="forbid")


class RuleUpdate(StrictModel):
    """约束政策规则的可编辑字段；场景和标识在路由中继续做业务校验。"""
    airline: str = Field(min_length=1, max_length=4)
    cabin: str = Field(min_length=1, max_length=8)
    fare_product: str = Field(min_length=1, max_length=40)
    scenario: str
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=20000)
    active: bool = True


class EvalCasesUpdate(StrictModel):
    """承载完整评测用例集；保存时按内容生成不可变版本。"""
    cases: list[dict]


class EvalRunRequest(StrictModel):
    """约束评测运行模式和用例选择；空选择表示运行当前用例集全量。"""
    mode: str = Field(default="offline", pattern=r"^(offline|deepseek)$")
    case_ids: list[str] | None = None


class MockScenarioUpdate(StrictModel):
    """切换仿真航司场景；场景定义来自 demo_data/airline_scenarios.json。"""
    scenario: str = Field(min_length=1, max_length=64)


class ConfigUpdate(StrictModel):
    """承载运行配置补丁和连通性探测开关；补丁只允许已知配置项。"""
    patch: dict
    probe_llm: bool = False


def _admin_error(code: str, message: str, status_code: int = 400):
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@router.get("/rules")
async def list_rules(principal: Principal = Depends(require_admin), airline: str | None = None,
                     cabin: str | None = None, fare_product: str | None = None,
                     scenario: str | None = None, q: str | None = Query(default=None, max_length=500),
                     debug: bool = False):
    """筛选并返回政策规则；调试模式可附带真实检索漏斗，便于观察召回和过滤。"""
    async with SessionFactory() as session:
        query = select(RuleRecord)
        if airline:
            query = query.where(RuleRecord.airline.in_((airline, "*")))
        if cabin:
            query = query.where(RuleRecord.cabin.in_((cabin, "*")))
        if fare_product:
            query = query.where(RuleRecord.fare_product.in_((fare_product, "*")))
        if scenario:
            query = query.where(RuleRecord.scenario == scenario)
        if q:
            query = query.where(RuleRecord.content.ilike(f"%{q}%") | RuleRecord.title.ilike(f"%{q}%"))
        rows = list(await session.scalars(query.order_by(RuleRecord.airline, RuleRecord.id)))
        response = {"rules": [{"id": row.id, "airline": row.airline, "cabin": row.cabin,
                               "fare_product": row.fare_product, "scenario": row.scenario,
                               "title": row.title, "content": row.content, "version": row.version,
                               "active": row.active, "updated_at": row.updated_at} for row in rows]}
        if debug:
            response["debug"] = {"filters": {"airline": airline, "cabin": cabin,
                                               "fare_product": fare_product, "scenario": scenario},
                                 "query": q, "result_count": len(rows)}
            if q:
                response["debug"]["retrieval"] = await asyncio.to_thread(
                    agent_retrieval.search, q, {key: value for key, value in {"airline": airline, "cabin": cabin,
                                                                               "fare_product": fare_product}.items() if value})
        return response


@router.put("/rules/{rule_id}")
async def upsert_rule(rule_id: str, request: RuleUpdate, principal: Principal = Depends(require_admin)):
    """新增或递增政策规则版本并写审计；提交后同步 Agent 投影并使旧索引失效。"""
    if not ID_PATTERN.fullmatch(rule_id):
        raise _admin_error("VALIDATION", "规则 ID 格式不合法")
    if request.scenario not in SCENARIOS:
        raise _admin_error("VALIDATION", "规则场景不支持")
    now = utcnow()
    async with SessionFactory() as session:
        row = await session.get(RuleRecord, rule_id)
        version = row.version + 1 if row else 1
        if row is None:
            row = RuleRecord(id=rule_id, version=version, updated_at=now, **request.model_dump())
            session.add(row)
        else:
            for key, value in request.model_dump().items():
                setattr(row, key, value)
            row.version, row.updated_at = version, now
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=principal.user_id,
                                action="policy.upsert", resource_id=rule_id,
                                payload={"version": version, "active": request.active}, created_at=now))
        await session.commit()
        response = {"rule": {"id": row.id, "version": row.version, "active": row.active,
                              "updated_at": row.updated_at}}
    await sync_rules_to_agent_index()
    return response


@router.get("/evaluations")
async def get_evaluations(view: str = Query(default="cases", pattern=r"^(cases|runs|run)$"),
                          run_id: str | None = None,
                          principal: Principal = Depends(require_admin)):
    """读取最新用例集、运行列表或单次报告；列表响应隐藏内部用例快照。"""
    async with SessionFactory() as session:
        if view == "run":
            if not run_id:
                raise _admin_error("VALIDATION", "查看单次运行需提供 run_id")
            row = await session.get(EvaluationRunRecord, run_id)
            if row is None:
                raise _admin_error("NOT_FOUND", "评测运行不存在", 404)
            progress = row.progress or {}
            return {"run_id": row.run_id, "status": row.status, "mode": row.mode,
                    "case_set_version": progress.get("case_set_version"),
                    "progress": public_progress(progress), "report": row.report,
                    "created_at": row.created_at, "updated_at": row.updated_at}
        if view == "cases":
            row = await session.scalar(select(EvaluationCaseSetRecord).order_by(desc(EvaluationCaseSetRecord.created_at)).limit(1))
            cases = row.cases if row else (json.loads(EVAL_CASES.read_text("utf-8")) if EVAL_CASES.exists() else [])
            return {"view": "cases", "version": row.version if row else "seed", "cases": cases}
        rows = list(await session.scalars(select(EvaluationRunRecord).order_by(desc(EvaluationRunRecord.created_at)).limit(100)))
        return {"view": "runs", "runs": [{"run_id": r.run_id, "status": r.status, "mode": r.mode,
                "case_set_version": (r.progress or {}).get("case_set_version"),
                "progress": public_progress(r.progress or {}), "created_at": r.created_at,
                "updated_at": r.updated_at} for r in rows]}


@router.put("/evaluations/cases")
async def put_evaluation_cases(request: EvalCasesUpdate, principal: Principal = Depends(require_admin)):
    """校验并保存不可变评测用例集；内容哈希作为版本，重复内容复用既有版本。"""
    ids = [case.get("id") for case in request.cases]
    if any(not isinstance(case_id, str) or not ID_PATTERN.fullmatch(case_id) for case_id in ids):
        raise _admin_error("VALIDATION", "每条用例都必须包含有效 id")
    if len(ids) != len(set(ids)):
        raise _admin_error("VALIDATION", "用例 id 不能重复")
    if any(not isinstance(case.get("question"), str) or not case.get("expect") for case in request.cases):
        raise _admin_error("VALIDATION", "每条用例必须包含 question 和 expect")
    raw = json.dumps(request.cases, ensure_ascii=False, sort_keys=True)
    version = hashlib.sha256(raw.encode()).hexdigest()[:16]
    now = utcnow()
    async with SessionFactory() as session:
        if await session.get(EvaluationCaseSetRecord, version) is None:
            session.add(EvaluationCaseSetRecord(version=version, cases=request.cases,
                                                created_at=now, created_by=principal.user_id))
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=principal.user_id,
                                action="evaluation.cases.update", resource_id=version,
                                payload={"count": len(request.cases)}, created_at=now))
        await session.commit()
    return {"version": version, "count": len(request.cases)}


@router.post("/evaluations/runs", status_code=202)
async def start_evaluation(request: EvalRunRequest, principal: Principal = Depends(require_admin)):
    """绑定当前用例快照并排队评测；运行、审计和 Outbox 在同一事务落库。"""
    run_id, now = f"run_{uuid.uuid4().hex}", utcnow()
    async with SessionFactory() as session:
        case_set = await session.scalar(select(EvaluationCaseSetRecord).order_by(
            desc(EvaluationCaseSetRecord.created_at)).limit(1))
        source_cases = case_set.cases if case_set else (
            json.loads(EVAL_CASES.read_text("utf-8")) if EVAL_CASES.exists() else [])
        if request.case_ids is not None and len(request.case_ids) != len(set(request.case_ids)):
            raise _admin_error("VALIDATION", "case_ids 不能重复")
        try:
            snapshot = select_case_snapshot(source_cases, request.case_ids)
        except ValueError as exc:
            raise _admin_error("VALIDATION", str(exc)) from exc
        version = case_set.version if case_set else "seed"
        progress = {"case_set_version": version, "case_snapshot": snapshot,
                    "selected_case_ids": [case["id"] for case in snapshot],
                    "completed": 0, "total": len(snapshot)}
        row = EvaluationRunRecord(run_id=run_id, status="QUEUED", mode=request.mode,
                                  progress=progress, report={}, created_at=now, updated_at=now)
        session.add(row)
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=principal.user_id,
                                action="evaluation.run", resource_id=run_id,
                                payload={"mode": request.mode, "case_ids": request.case_ids or []}, created_at=now))
        session.add(OutboxRecord(event_id=f"evt_{uuid.uuid4().hex}", topic="evaluation.run",
                                 aggregate_id=run_id, payload={"run_id": run_id, "mode": request.mode,
                                 "case_ids": request.case_ids}, created_at=now))
        await session.commit()
    return {"run_id": run_id, "status": "QUEUED"}


@router.get("/config")
async def get_config(principal: Principal = Depends(require_admin)):
    """返回脱敏后的运行配置；API Key 不会原样暴露给管理前端。"""
    return legacy_settings.public()


@router.put("/config")
async def put_config(request: ConfigUpdate, principal: Principal = Depends(require_admin)):
    """按需探测模型连通性后更新配置；掩码密钥不覆盖原值，审计只记录修改键名。"""
    patch = request.patch
    if isinstance(patch.get("llm"), dict) and "****" in str(patch["llm"].get("api_key", "")):
        patch = {**patch, "llm": {k: v for k, v in patch["llm"].items() if k != "api_key"}}
        if not patch["llm"]:
            patch.pop("llm")
    if request.probe_llm:
        cfg = legacy_settings.get()["llm"]
        patch_llm = patch.get("llm", {})
        base_url = patch_llm.get("base_url", cfg["base_url"])
        api_key = patch_llm.get("api_key", cfg["api_key"])
        model = patch_llm.get("model", cfg["model"])
        if not api_key:
            raise _admin_error("LLM_NOT_CONFIGURED", "请先填写 LLM API Key")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(f"{base_url.rstrip('/')}/chat/completions",
                                             headers={"Authorization": f"Bearer {api_key}"},
                                             json={"model": model, "messages": [{"role": "user", "content": "ping"}],
                                                   "max_tokens": 1, "temperature": 0})
                response.raise_for_status()
        except Exception as exc:
            raise _admin_error("LLM_PROBE_FAILED", f"LLM 连通性检查失败：{type(exc).__name__}", 502) from exc
    try:
        legacy_settings.update(patch)
    except (KeyError, TypeError, ValueError) as exc:
        raise _admin_error("VALIDATION", str(exc)) from exc
    now = utcnow()
    async with SessionFactory() as session:
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=principal.user_id,
                                action="config.update", resource_id=None,
                                payload={"keys": sorted(patch)}, created_at=now))
        await session.commit()
    public = legacy_settings.public()
    return {"config": public, "llm_probe": "passed" if request.probe_llm else None}


def _scenario_path() -> Path:
    return Path(__file__).resolve().parents[4] / "demo_data" / "airline_scenarios.json"


def _load_scenarios() -> list[dict]:
    path = _scenario_path()
    if not path.exists():
        return [{"id": "normal", "title": "正常办理"}]
    return json.loads(path.read_text("utf-8"))


@router.get("/mock/scenarios")
async def list_mock_scenarios(principal: Principal = Depends(require_admin)):
    """列出可用仿真场景及当前选择。"""
    current = legacy_settings.get()["airline"].get("scenario", "normal")
    return {"scenario": current,
            "scenarios": [{"id": item.get("id"), "title": item.get("title", item.get("id")),
                           "description": item.get("description", "")} for item in _load_scenarios()]}


@router.put("/mock")
async def set_mock_scenario(request: MockScenarioUpdate, principal: Principal = Depends(require_admin)):
    """切换场景并同步航班状态；只改演示数据，不动真实订单与账本。"""
    scenarios = {item.get("id"): item for item in _load_scenarios()}
    scenario = scenarios.get(request.scenario)
    if scenario is None:
        raise _admin_error("VALIDATION", "仿真场景不存在")
    legacy_settings.update({"airline": {"scenario": request.scenario}})
    from app.adapters.outbound.persistence.models import FlightRecord
    from app.adapters.outbound.sqlite import data as legacy_data
    changed = []
    async with SessionFactory() as session:
        # 每次切换先回到正常状态，再应用当前场景覆盖，避免场景之间残留。
        all_rows = list(await session.scalars(select(FlightRecord)))
        for row in all_rows:
            row.status, row.delay_min = "scheduled", 0
            legacy_data.set_flight_status(row.flight_no, row.date, status="scheduled", delay_min=0)
        for flight_no, override in (scenario.get("flight_overrides") or {}).items():
            rows = [row for row in all_rows if row.flight_no == flight_no]
            for row in rows:
                row.status = override.get("status", row.status)
                row.delay_min = override.get("delay_min", 0) if row.status == "delayed" else 0
                legacy_data.set_flight_status(row.flight_no, row.date, status=row.status,
                                              delay_min=row.delay_min)
                changed.append({"flight_no": row.flight_no, "date": row.date,
                                "status": row.status, "delay_min": row.delay_min})
        now = utcnow()
        session.add(AuditRecord(audit_id=f"audit_{uuid.uuid4().hex}", actor_id=principal.user_id,
                                action="mock.scenario", resource_id=request.scenario,
                                payload={"changed": changed}, created_at=now))
        await session.commit()
    return {"scenario": request.scenario, "title": scenario.get("title"), "changed": changed}
