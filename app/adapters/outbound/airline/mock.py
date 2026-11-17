"""支持结果注入和回执持久化的确定性航司模拟器。"""
import asyncio
import hashlib
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import AirlineReceiptRecord


class MockAirlineGateway:
    """用持久化回执模拟航司办理；支持延迟和结果注入，并按幂等键防重复提交。"""
    def __init__(self, *, delay_seconds: float = 0, outcomes: dict | None = None, session_factory=None):
        if delay_seconds < 0:
            raise ValueError("delay_seconds 不能为负数")
        self.delay_seconds = delay_seconds
        self.session_factory = session_factory or SessionFactory
        self._outcomes = {key: list(value) if isinstance(value, (list, tuple)) else value
                          for key, value in (outcomes or {}).items()}
        self._lock = asyncio.Lock()

    def _next_outcome(self, key: str) -> str:
        configured = self._outcomes.get(key, "ACCEPTED")
        if isinstance(configured, list):
            return configured.pop(0) if configured else "ACCEPTED"
        return configured

    async def submit(self, command: dict) -> dict:
        """模拟航司受理、拒绝或超时；回执唯一键冲突时读取既有结果，保证并发幂等。"""
        key = command["idempotency_key"]
        async with self._lock:
            stored = await self.find_by_idempotency_key(key)
            if stored is not None:
                return {**stored, "idempotent": True}
            if self.delay_seconds:
                await asyncio.sleep(self.delay_seconds)
            outcome = self._next_outcome(key)
            reference = f"mock-{hashlib.sha256(key.encode()).hexdigest()[:16]}"
            if outcome == "TIMEOUT":
                return {"status": "TIMEOUT", "code": "SUPPLIER_TIMEOUT",
                        "message": "航司响应超时，办理结果待核对", "retryable": True, "idempotent": False}
            if outcome not in {"ACCEPTED", "REJECTED"}:
                raise ValueError(f"不支持的航司 mock 结果：{outcome}")
            result = {"supplier_reference": reference, "status": outcome, "idempotent": False}
            if outcome == "REJECTED":
                result.update(code="SUPPLIER_REJECTED", message="航司拒绝办理", retryable=False)
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
