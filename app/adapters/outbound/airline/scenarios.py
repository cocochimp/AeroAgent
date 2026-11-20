"""仿真航司场景加载与匹配；场景只影响演示数据，不改变真实交易语义。"""
import hashlib
import json
from pathlib import Path

from app import config

SCENARIO_PATH = Path(__file__).resolve().parents[4] / "demo_data" / "airline_scenarios.json"


def load_scenarios(path: Path | None = None) -> list[dict]:
    """读取场景文件；缺失时返回正常场景，保证离线可跑。"""
    target = path or SCENARIO_PATH
    if not target.exists():
        return [{"id": "normal", "title": "正常办理"}]
    return json.loads(target.read_text("utf-8"))


def scenario_for(scenario_id: str, path: Path | None = None) -> dict:
    """按 id 取场景；未知 id 回退正常场景。"""
    for item in load_scenarios(path):
        if item.get("id") == scenario_id:
            return item
    return {"id": "normal", "title": "正常办理"}


def current_scenario() -> dict:
    """读取运行配置中的当前场景。"""
    return scenario_for(config.get().get("airline", {}).get("scenario", "normal"))


def _bucket(key: str, salt: str) -> float:
    """由幂等键派生 0–1 的确定性比例，避免同一请求每次得到不同故障。"""
    digest = hashlib.sha256(f"{salt}:{key}".encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def scenario_outcome(scenario: dict, key: str, command: dict) -> str:
    """按场景 outcomes/faults 计算一次结果；默认接受。"""
    action = command.get("action")
    for rule in scenario.get("outcomes") or []:
        match = rule.get("match") or {}
        if match.get("action") and match["action"] != action:
            continue
        configured = rule.get("status")
        if isinstance(configured, list):
            return configured[0] if configured else "ACCEPTED"
        if configured:
            return configured
    faults = scenario.get("faults") or {}
    if _bucket(key, "reject") < float(faults.get("reject_rate", 0)):
        return "REJECTED"
    if _bucket(key, "timeout") < float(faults.get("timeout_rate", 0)):
        return "TIMEOUT"
    return "ACCEPTED"
