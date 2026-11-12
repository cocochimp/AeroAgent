"""Deterministic idempotent mock airline gateway used by the demo."""
import hashlib


class MockAirlineGateway:
    def __init__(self):
        self._results: dict[str, dict] = {}

    async def submit(self, command: dict) -> dict:
        key = command["idempotency_key"]
        if key in self._results:
            return {**self._results[key], "idempotent": True}
        result = {"supplier_reference": f"mock-{hashlib.sha256(key.encode()).hexdigest()[:16]}",
                  "status": "ACCEPTED", "idempotent": False}
        self._results[key] = result
        return result

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        return self._results.get(key)


mock_airline = MockAirlineGateway()
