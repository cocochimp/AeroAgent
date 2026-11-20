"""航司适配器契约：mock/http/cassette 对同一命令给出一致语义。"""
import asyncio
import json

import httpx

from app.adapters.outbound.airline.cassette import CassetteAirlineGateway
from app.adapters.outbound.airline.http import HttpAirlineGateway
from app.adapters.outbound.airline.mock import MockAirlineGateway


def test_mock_scenario_accepts_rejects_and_times_out(tmp_path):
    from app import config as S
    from app.adapters.outbound.persistence import database
    S.VAR_DIR.mkdir(parents=True, exist_ok=True)
    asyncio.run(database.initialize_schema())

    async def run():
        gateway = MockAirlineGateway(scenario={"id": "test", "ticket_prefix": "MU", "latency_ms": 0,
            "faults": {"reject_rate": 0, "timeout_rate": 0}})
        accepted = await gateway.submit({"idempotency_key": "ct-accept", "action": "CHANGE", "amount": 100})
        assert accepted["status"] == "ACCEPTED" and accepted["ticket_no"].startswith("MU-")
        assert accepted["raw"]["simulated"] is True
        rejected = await MockAirlineGateway(scenario={"id": "reject", "latency_ms": 0,
            "faults": {"reject_rate": 1, "timeout_rate": 0}}).submit(
            {"idempotency_key": "ct-reject", "action": "REFUND", "amount": 100})
        assert rejected["status"] == "REJECTED" and rejected["retryable"] is False
        timeout = await MockAirlineGateway(scenario={"id": "timeout", "latency_ms": 0,
            "faults": {"reject_rate": 0, "timeout_rate": 1}}).submit(
            {"idempotency_key": "ct-timeout", "action": "REFUND", "amount": 100})
        assert timeout["status"] == "TIMEOUT" and timeout["retryable"] is True
    asyncio.run(run())


def test_http_adapter_maps_success_rejection_and_timeout():
    async def run():
        def handler(request: httpx.Request) -> httpx.Response:
            key = request.headers.get("Idempotency-Key")
            if key == "http-timeout":
                raise httpx.ReadTimeout("slow", request=request)
            if key == "http-reject":
                return httpx.Response(409, json={"status": "REJECTED", "code": "SEAT_SOLD_OUT"})
            return httpx.Response(200, json={"status": "ACCEPTED", "supplier_reference": "GDS-1",
                                             "ticket_no": "781-1234567890", "pnr": "ABC123"})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        gateway = HttpAirlineGateway(base_url="https://gds.test", auth_header="Bearer t", client=client)
        accepted = await gateway.submit({"idempotency_key": "http-ok", "action": "CHANGE"})
        assert accepted["status"] == "ACCEPTED" and accepted["ticket_no"] == "781-1234567890"
        rejected = await gateway.submit({"idempotency_key": "http-reject", "action": "REFUND"})
        assert rejected["status"] == "REJECTED" and rejected["code"] == "SEAT_SOLD_OUT"
        timeout = await gateway.submit({"idempotency_key": "http-timeout", "action": "REFUND"})
        assert timeout["status"] == "TIMEOUT" and timeout["retryable"] is True
        await client.aclose()
    asyncio.run(run())


def test_cassette_replay_is_deterministic(tmp_path):
    async def run():
        path = tmp_path / "airline_cassettes.json"
        path.write_text(json.dumps({
            "cassette-ok": {"status": "ACCEPTED", "supplier_reference": "GDS-C", "ticket_no": "781-1"},
            "cassette-reject": {"status": "REJECTED", "code": "NO_SEAT"},
        }), "utf-8")
        gateway = CassetteAirlineGateway(path)
        first = await gateway.submit({"idempotency_key": "cassette-ok", "action": "CHANGE"})
        replay = await gateway.submit({"idempotency_key": "cassette-ok", "action": "CHANGE"})
        assert first["status"] == "ACCEPTED" and first["idempotent"] is False
        assert replay["idempotent"] is True
        assert (await gateway.find_by_idempotency_key("cassette-reject"))["code"] == "NO_SEAT"
        missing = await gateway.submit({"idempotency_key": "missing", "action": "REFUND"})
        assert missing["status"] == "UNKNOWN" and missing["code"] == "CASSETTE_MISS"
    asyncio.run(run())
