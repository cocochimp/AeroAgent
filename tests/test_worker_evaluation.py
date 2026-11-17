import asyncio
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import evaluation, worker


@pytest.mark.parametrize(("frozen", "prefix"), [
    (False, [sys.executable, "-m", "app.evaluation"]),
    (True, [sys.executable, "evaluation"]),
])
def test_worker_runs_the_case_snapshot_bound_to_run_record(monkeypatch, tmp_path, frozen, prefix):
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
    monkeypatch.setattr(sys, "frozen", frozen, raising=False)

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
        seen["args"] = args
        seen["cases"] = json.loads(open(path, encoding="utf-8").read())
        seen["cwd"] = kwargs["cwd"]
        (tmp_path / "run1.json").write_text(json.dumps({"summary": {"n": 1}, "results": []}), "utf-8")
        return Process()
    monkeypatch.setattr(worker.asyncio, "create_subprocess_exec", create_process)

    asyncio.run(worker.run_evaluation({"run_id": "run1", "mode": "offline"}))
    assert list(seen["args"][:len(prefix) + 1]) == [*prefix, "run"]
    assert seen["cases"] == cases
    assert row.status == "SUCCEEDED"
    assert row.progress["case_set_version"] == "v9"
    assert row.progress["completed"] == 1
    assert row.report["case_set_version"] == "v9"


def test_frozen_backend_entry_configures_user_data_and_dispatches_evaluation(monkeypatch, tmp_path):
    from desktop import backend_entry

    calls = []
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "argv", ["aeroagent-api", "evaluation", "run", "--mode", "offline"])
    monkeypatch.setenv("AEROAGENT_USER_DATA", str(tmp_path))
    monkeypatch.delenv("AIR_VAR_DIR", raising=False)
    monkeypatch.delenv("AIR_CONFIG_PATH", raising=False)
    monkeypatch.setattr(evaluation, "main", calls.append)

    backend_entry.main()

    assert calls == [["run", "--mode", "offline"]]
    assert os.environ["AIR_VAR_DIR"] == str(tmp_path / "var")
    assert os.environ["AIR_CONFIG_PATH"] == str(tmp_path / "config.json")


def test_desktop_bundle_contains_evaluation_assets():
    root = Path(__file__).resolve().parents[1]
    builder = (root / "desktop" / "electron-builder.yml").read_text(encoding="utf-8")
    backend_build = (root / "desktop" / "scripts" / "build-backend.cjs").read_text(encoding="utf-8")
    main = (root / "desktop" / "main.cjs").read_text(encoding="utf-8")

    assert "from: ../eval" in builder
    assert "to: eval" in builder
    assert "addData('eval', 'eval')" in backend_build
    assert "env.AEROAGENT_USER_DATA = userData" in main
