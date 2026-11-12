import asyncio
import json
from types import SimpleNamespace

from backend.app import worker


def test_worker_runs_the_case_snapshot_bound_to_run_record(monkeypatch, tmp_path):
    cases = [{"id": "snapshot-only", "question": "退票", "expect": {"outcome": "ANSWER"}}]
    row = SimpleNamespace(status="QUEUED", mode="offline", progress={"case_set_version": "v9",
        "case_snapshot": cases, "selected_case_ids": ["snapshot-only"]}, report={}, updated_at=None)
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key): return row
        async def commit(self): pass
    monkeypatch.setattr(worker, "SessionFactory", Session)
    monkeypatch.setattr(worker.evaluation, "RUNS_DIR", tmp_path)

    class Stdout:
        def __init__(self): self.lines = iter([
            b'{"type":"progress","done":1,"total":1,"case_id":"snapshot-only","passed":true}\n',
            b'{"type":"done","run_id":"run1","summary":{"n":1}}\n'])
        async def readline(self): return next(self.lines, b"")
    class Stderr:
        async def read(self): return b""
    class Process:
        stdout, stderr = Stdout(), Stderr()
        async def wait(self): return 0
    seen = {}
    async def create_process(*args, **kwargs):
        path = args[args.index("--cases") + 1]
        seen["cases"] = json.loads(open(path, encoding="utf-8").read())
        seen["cwd"] = kwargs["cwd"]
        (tmp_path / "run1.json").write_text(json.dumps({"summary": {"n": 1}, "results": []}), "utf-8")
        return Process()
    monkeypatch.setattr(worker.asyncio, "create_subprocess_exec", create_process)

    asyncio.run(worker.run_evaluation({"run_id": "run1", "mode": "offline"}))
    assert seen["cases"] == cases
    assert row.status == "SUCCEEDED"
    assert row.progress["case_set_version"] == "v9"
    assert row.progress["completed"] == 1
    assert row.report["case_set_version"] == "v9"
