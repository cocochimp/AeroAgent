"""录制/回放航司响应：真实接口样本可在离线 CI 与演示中复用。"""
import json
from pathlib import Path


class CassetteAirlineGateway:
    """按幂等键回放 JSON 样本；缺失样本视为结果未知。"""

    def __init__(self, path: Path):
        self.path = path
        self._seen: set[str] = set()

    def _load(self) -> dict:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text("utf-8"))

    async def submit(self, command: dict) -> dict:
        """回放一条航司结果；同一键第二次提交标记为幂等重放。"""
        key = command["idempotency_key"]
        entry = self._load().get(key)
        if entry is None:
            return {"status": "UNKNOWN", "code": "CASSETTE_MISS", "message": "没有可回放的航司响应",
                    "retryable": False, "idempotent": False}
        idempotent = key in self._seen
        self._seen.add(key)
        return {**entry, "idempotent": idempotent}

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        """按幂等键读取回放样本；缺失时返回空值。"""
        return self._load().get(key)
