"""支持场景、延迟和结果注入的确定性航司模拟器。"""
import asyncio
import hashlib
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError

from app.adapters.outbound.airline.scenarios import current_scenario, scenario_outcome
from app.adapters.outbound.persistence.database import SessionFactory
from app.adapters.outbound.persistence.models import AirlineReceiptRecord


def _ticket_no(prefix: str, key: str) -> str:
    digest = hashlib.sha256(key.encode()).hexdigest()
    return f"{prefix or '781'}-{int(digest[:12], 16) % 10**10:010d}"


def _pnr(key: str) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    digest = hashlib.sha256(f"pnr:{key}".encode()).digest()
    return "".join(alphabet[byte % len(alphabet)] for byte in digest[:6])


class MockAirlineGateway:
    """用持久化回执模拟航司办理；支持延迟、场景和按幂等键防重复提交。"""
    def __init__(self, *, delay_seconds: float = 0, outcomes: dict | None = None,
                 session_factory=None, scenario: dict | None = None):
        if delay_seconds < 0:
            raise ValueError("delay_seconds 不能为负数")
        self.delay_seconds = delay_seconds
        self.session_factory = session_factory or SessionFactory
        self._outcomes = {key: list(value) if isinstance(value, (list, tuple)) else value
                          for key, value in (outcomes or {}).items()}
        self._scenario = scenario
        self._lock = asyncio.Lock()

    def _scenario_config(self) -> dict:
        if self._scenario is None:
            self._scenario = current_scenario()
        return self._scenario

    def _next_outcome(self, key: str, command: dict) -> str:
        configured = self._outcomes.get(key)
        if isinstance(configured, list):
            return configured.pop(0) if configured else "ACCEPTED"
        if configured:
            return configured
        return scenario_outcome(self._scenario_config(), key, command)

    async def submit(self, command: dict) -> dict:
        """模拟航司受理、拒绝或超时；回执唯一键冲突时读取既有结果，保证并发幂等。"""
        key = command["idempotency_key"]
        async with self._lock:
            stored = await self.find_by_idempotency_key(key)
            if stored is not None:
                return {**stored, "idempotent": True}
            scenario = self._scenario_config()
            delay = self.delay_seconds or float(scenario.get("latency_ms", 0)) / 1000
            if delay:
                await asyncio.sleep(delay)
            outcome = self._next_outcome(key, command)
            reference = f"{scenario.get('supplier_prefix', 'mock')}-{hashlib.sha256(key.encode()).hexdigest()[:16]}"
            if outcome == "TIMEOUT":
                return {"status": "TIMEOUT", "code": "SUPPLIER_TIMEOUT",
                        "message": "航司响应超时，办理结果待核对", "retryable": True, "idempotent": False,
                        "simulation": {"scenario": scenario.get("id"), "outcome": outcome}}
            if outcome not in {"ACCEPTED", "REJECTED"}:
                raise ValueError(f"不支持的航司 mock 结果：{outcome}")
            result = {"supplier_reference": reference, "status": outcome, "idempotent": False,
                      "raw": {"simulated": True, "scenario": scenario.get("id")},
                      "simulation": {"scenario": scenario.get("id"), "outcome": outcome}}
            if outcome == "REJECTED":
                result.update(code=scenario.get("reject_code", "SUPPLIER_REJECTED"),
                              message=scenario.get("reject_message", "航司拒绝办理"), retryable=False)
            else:
                if command.get("action") == "REFUND":
                    result["refund_amount"] = int(command.get("amount") or 0)
                else:
                    result["ticket_no"] = _ticket_no(scenario.get("ticket_prefix", "781"), key)
                    result["pnr"] = _pnr(key)
            async with self.session_factory() as session:
                session.add(AirlineReceiptRecord(idempotency_key=key, receipt=result,
                                                 created_at=datetime.now(timezone.utc)))
                try:
                    await session.commit()
                except IntegrityError:
                    await session.rollback()
                    existing = await session.get(AirlineReceiptRecord, key)
                    if existing is None:
                        raise
                    return {**existing.receipt, "idempotent": True}
            return result

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        """读取持久化航司回执；未办理过返回空值。"""
        async with self.session_factory() as session:
            row = await session.get(AirlineReceiptRecord, key)
            return dict(row.receipt) if row else None


mock_airline = MockAirlineGateway()
