import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PRELOAD = r"""
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const childProcess = require('node:child_process');
const Module = require('node:module');

const mode = process.env.DEV_TEST_MODE;
const output = process.env.DEV_TEST_OUTPUT;
const events = [];
let ready = false;
let electronReady = null;
let finished = false;
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return 'fake-electron';
  return originalLoad.call(this, request, parent, isMain);
};

http.get = function(url, options, callback) {
  const request = new EventEmitter();
  request.destroy = (error) => {
    if (error) process.nextTick(() => request.emit('error', error));
  };
  process.nextTick(() => {
    if (!ready) {
      request.emit('error', new Error('connect ECONNREFUSED'));
      return;
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = () => {};
    callback(response);
  });
  return request;
};

function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(output, JSON.stringify({ events, electronReady }));
  clearTimeout(watchdog);
  process.exit(code);
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    process.nextTick(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  };
  return child;
}

childProcess.spawn = function(command, args) {
  if (command.includes('npm')) {
    events.push('vite');
    if (mode === 'ready') setTimeout(() => { ready = true; }, 200);
    return fakeChild(4101);
  }
  if (command === 'fake-electron') {
    events.push('electron');
    electronReady = ready;
    finish(0);
    return fakeChild(4102);
  }
  throw new Error(`unexpected spawn: ${command}`);
};

const realKill = process.kill.bind(process);
process.kill = function(pid, signal) {
  if (pid === -4101 || pid === -4102) {
    const error = new Error('ESRCH');
    error.code = 'ESRCH';
    throw error;
  }
  return realKill(pid, signal);
};
const watchdog = setTimeout(() => finish(2), 2000);
"""


def _run_dev(tmp_path, mode):
    preload = tmp_path / f"{mode}-preload.cjs"
    output = tmp_path / f"{mode}-result.json"
    preload.write_text(PRELOAD, encoding="utf-8")
    completed = subprocess.run(
        ["node", "--require", str(preload), str(ROOT / "desktop" / "scripts" / "dev.cjs")],
        cwd=ROOT,
        env={
            **os.environ,
            "DEV_TEST_MODE": mode,
            "DEV_TEST_OUTPUT": str(output),
            "AEROAGENT_VITE_READY_TIMEOUT_MS": "1500" if mode == "ready" else "150",
        },
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    return completed, output


def test_dev_waits_until_vite_url_is_ready_before_starting_electron(tmp_path):
    completed, output = _run_dev(tmp_path, "ready")

    assert completed.returncode == 0, completed.stderr
    result = json.loads(output.read_text(encoding="utf-8"))
    assert result["events"] == ["vite", "electron"]
    assert result["electronReady"] is True


def test_dev_reports_vite_ready_timeout_without_starting_electron(tmp_path):
    completed, output = _run_dev(tmp_path, "timeout")

    assert completed.returncode != 0
    assert "Vite" in completed.stderr
    assert "超时" in completed.stderr
    if output.exists():
        assert "electron" not in json.loads(output.read_text(encoding="utf-8"))["events"]
