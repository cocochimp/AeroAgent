"""在进程内消费会话、履约和评测任务，并负责 Outbox 投递。"""
import asyncio
import json
import logging
import os
from pathlib import Path

from sqlalchemy import select

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import OutboxRecord, EvaluationRunRecord
from app.adapters.outbound.redis.streams import Streams
from app.application.cases.service import run_case_turn, utcnow
from app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent
from app.adapters.outbound.telemetry.tracing import configure_tracing
from app import evaluation
from app.application.monitoring import evaluate_all_watches

logger = logging.getLogger(__name__)
WATCH_EVALUATION_INTERVAL_SECONDS = max(1.0, float(os.getenv(
    "AEROAGENT_WATCH_INTERVAL_SECONDS", "60")))


async def _save_progress(run_id: str, progress: dict) -> None:
    """合并保存评测进度；每次使用独立事务，避免长事务包裹子进程。"""
    async with SessionFactory() as session:
        row = await session.get(EvaluationRunRecord, run_id)
        if row:
            row.progress = {**(row.progress or {}), **progress}
            row.updated_at = utcnow()
            await session.commit()


async def run_evaluation(payload: dict) -> None:
    """执行绑定用例快照的离线评测子进程；持续落进度并保证异常和临时文件都有终态处理。"""
    run_id, mode = payload["run_id"], payload.get("mode", "offline")
    snapshot_file = None
    try:
        async with SessionFactory() as session:
            row = await session.get(EvaluationRunRecord, run_id)
            if row is None or row.status in {"SUCCEEDED", "FAILED"}:
                return
            progress = row.progress or {}
            cases = progress.get("case_snapshot")
            if not isinstance(cases, list):
                raise ValueError("评测运行缺少已绑定的用例快照")
            version = progress.get("case_set_version", "seed")
            row.status, row.updated_at = "RUNNING", utcnow()
            row.progress = {**progress, "completed": 0, "total": len(cases), "current_case_id": None}
            await session.commit()

        input_dir = evaluation.RUNS_DIR / ".inputs"
        input_dir.mkdir(parents=True, exist_ok=True)
        snapshot_file = input_dir / f"{run_id}.json"
        snapshot_file.write_text(json.dumps(cases, ensure_ascii=False), "utf-8")
        args = [*evaluation_command(), "run", "--mode", mode,
                "--run-id", run_id, "--cases", str(snapshot_file)]
        process = await asyncio.create_subprocess_exec(
            *args, cwd=Path(__file__).resolve().parents[1],
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        # 并发读完 stderr 再等待退出，避免管道写满让子进程与 worker 互相等待。
        stderr_task = asyncio.create_task(process.stderr.read())
        lines = []
        done_message = None
        while True:
            raw_line = await process.stdout.readline()
            if not raw_line:
                break
            line = raw_line.decode("utf-8", errors="replace").strip()
            lines.append(line)
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("type") == "progress":
                await _save_progress(run_id, {"completed": message.get("done", 0),
                    "total": message.get("total", len(cases)), "current_case_id": message.get("case_id"),
                    "last_case_passed": message.get("passed")})
            elif message.get("type") == "done":
                done_message = message
        return_code = await process.wait()
        stderr = (await stderr_task).decode("utf-8", errors="replace")
        report_path = evaluation.RUNS_DIR / f"{run_id}.json"
        if report_path.exists():
            report = json.loads(report_path.read_text("utf-8"))
        else:
            report = {"stdout": "\n".join(lines)[-8000:], "stderr": stderr[-8000:],
                      "returncode": return_code}
        report["case_set_version"] = version
        status = "SUCCEEDED" if return_code == 0 and done_message else "FAILED"
        final_progress = {"completed": len(cases) if status == "SUCCEEDED" else (row.progress or {}).get("completed", 0),
                          "total": len(cases), "case_set_version": version,
                          "case_snapshot": cases, "selected_case_ids": [case["id"] for case in cases]}
        async with SessionFactory() as session:
            row = await session.get(EvaluationRunRecord, run_id)
            if row:
                row.status, row.report, row.progress, row.updated_at = status, report, final_progress, utcnow()
                await session.commit()
    except Exception as exc:
        async with SessionFactory() as session:
            row = await session.get(EvaluationRunRecord, run_id)
            if row:
                row.status = "FAILED"
                row.report = {"error": f"{type(exc).__name__}: {exc}"}
                row.progress = {**(row.progress or {}), "failed": True}
                row.updated_at = utcnow()
                await session.commit()
    finally:
        if snapshot_file:
            snapshot_file.unlink(missing_ok=True)


def sys_executable() -> str:
    """返回当前 Python 解释器路径；确保评测子进程沿用同一虚拟环境。"""
    import sys
    return sys.executable


def evaluation_command() -> list[str]:
    """返回评测子进程启动命令；打包环境走桌面入口的 evaluation 分派。"""
    import sys
    if getattr(sys, "frozen", False):
        return [sys.executable, "evaluation"]
    return [sys.executable, "-m", "app.evaluation"]


async def _process(kind: str, payload: dict) -> None:
    """按任务类型调用对应处理器；未知类型立即失败并进入重试流程。"""
    if kind == "case.turn":
        await run_case_turn(payload)
    elif kind == "fulfillment.submit":
        await TicketTransactionAgent().execute(ConfirmedQuoteCommand(payload["operation_id"]))
    elif kind == "evaluation.run":
        await run_evaluation(payload)
    else:
        raise ValueError(f"未知任务类型：{kind}")


async def _dispatch_outbox(streams: Streams) -> None:
    """将未发布 Outbox 记录按序写入任务流；入流成功后才标记发布时间，崩溃时允许重复投递。"""
    async with SessionFactory() as session:
        rows = list(await session.scalars(select(OutboxRecord).where(OutboxRecord.published_at.is_(None))
                                          .order_by(OutboxRecord.created_at).limit(50)))
        for row in rows:
            # 先入流再标记发布；两步间崩溃允许重复投递，由消费端幂等兜底。
            await streams.enqueue(row.topic, row.payload)
            row.published_at = utcnow()
        if rows:
            await session.commit()


async def run_worker() -> None:
    """轮询 Outbox、消费异步任务，并仅在后端运行期间定时评估 SQL 价格监控。"""
    configure_tracing("aeroagent-worker")
    streams = Streams()
    next_watch_evaluation = 0.0
    try:
        while True:
            loop = asyncio.get_running_loop()
            if loop.time() >= next_watch_evaluation:
                try:
                    await evaluate_all_watches()
                except Exception:
                    # 监控失败不能中断案件与履约消费；下一轮仍会按持久化状态重试。
                    logger.exception("Scheduled price-watch evaluation failed")
                next_watch_evaluation = loop.time() + WATCH_EVALUATION_INTERVAL_SECONDS
            await _dispatch_outbox(streams)
            batches = await streams.read_tasks(count=5, block_ms=1000)
            for _, messages in batches:
                for _, values in messages:
                    kind = values.get("kind", "")
                    payload = {}
                    try:
                        payload = json.loads(values.get("payload", "{}"))
                        await _process(kind, payload)
                    except Exception as exc:
                        attempts = int(values.get("attempts", 0)) + 1
                        await streams.enqueue(kind, payload, attempts=attempts,
                                              error=f"{type(exc).__name__}: {exc}", dead=attempts > 3)
    finally:
        await streams.close()


if __name__ == "__main__":
    asyncio.run(run_worker())
