"""Redis Streams worker for cases, fulfillment, and evaluation runs."""
import asyncio
import json
import os
import socket
from pathlib import Path

from sqlalchemy import select

from backend.app.adapters.outbound.postgres.database import SessionFactory
from backend.app.adapters.outbound.postgres.models import OutboxRecord, EvaluationRunRecord
from backend.app.adapters.outbound.redis.streams import TASK_STREAM, Streams
from backend.app.application.cases.service import run_case_turn, utcnow
from backend.app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent
from backend.app.adapters.outbound.telemetry.tracing import configure_tracing
from air_agent import evaluation

GROUP = os.getenv("REDIS_CONSUMER_GROUP", "air-ticket-workers")
CONSUMER = os.getenv("REDIS_CONSUMER_NAME", socket.gethostname())
DEAD_STREAM = "air-ticket:tasks:dead"


async def _save_progress(run_id: str, progress: dict) -> None:
    async with SessionFactory() as session:
        row = await session.get(EvaluationRunRecord, run_id)
        if row:
            row.progress = {**(row.progress or {}), **progress}
            row.updated_at = utcnow()
            await session.commit()


async def run_evaluation(payload: dict) -> None:
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
        args = [sys_executable(), "-m", "air_agent.evaluation", "run", "--mode", mode,
                "--run-id", run_id, "--cases", str(snapshot_file)]
        process = await asyncio.create_subprocess_exec(
            *args, cwd=Path(__file__).resolve().parents[2],
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
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
    import sys
    return sys.executable


async def _process(kind: str, payload: dict) -> None:
    if kind == "case.turn":
        await run_case_turn(payload)
    elif kind == "fulfillment.submit":
        await TicketTransactionAgent().execute(ConfirmedQuoteCommand(payload["operation_id"]))
    elif kind == "evaluation.run":
        await run_evaluation(payload)
    else:
        raise ValueError(f"未知任务类型：{kind}")


async def _dispatch_outbox(streams: Streams) -> None:
    async with SessionFactory() as session:
        rows = list(await session.scalars(select(OutboxRecord).where(OutboxRecord.published_at.is_(None))
                                          .order_by(OutboxRecord.created_at).limit(50)))
        for row in rows:
            await streams.enqueue(row.topic, row.payload)
            row.published_at = utcnow()
        if rows:
            await session.commit()


async def run_worker() -> None:
    configure_tracing("air-ticket-worker")
    streams = Streams()
    client = streams.client
    try:
        try:
            await client.xgroup_create(TASK_STREAM, GROUP, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise
        while True:
            await _dispatch_outbox(streams)
            try:
                pending = await client.xautoclaim(TASK_STREAM, GROUP, CONSUMER,
                                                  min_idle_time=60_000, start_id="0-0", count=5)
                claimed = pending[1] if pending else []
            except Exception:
                claimed = []
            batches = [(TASK_STREAM, claimed)] if claimed else await client.xreadgroup(
                GROUP, CONSUMER, {TASK_STREAM: ">"}, count=5, block=1000)
            for _, messages in batches:
                for message_id, values in messages:
                    kind = values.get("kind", "")
                    try:
                        payload = json.loads(values.get("payload", "{}"))
                        await _process(kind, payload)
                    except Exception as exc:
                        attempts = int(values.get("attempts", 0)) + 1
                        retry = {"kind": kind, "payload": values.get("payload", "{}"), "attempts": attempts,
                                 "error": f"{type(exc).__name__}: {exc}"}
                        if attempts <= 3:
                            await client.xadd(TASK_STREAM, retry, maxlen=10000, approximate=True)
                        else:
                            await client.xadd(DEAD_STREAM, retry, maxlen=10000, approximate=True)
                    finally:
                        await client.xack(TASK_STREAM, GROUP, message_id)
    finally:
        await streams.close()


if __name__ == "__main__":
    asyncio.run(run_worker())
