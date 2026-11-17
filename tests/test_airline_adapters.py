import asyncio
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.outbound.airline.mock import MockAirlineGateway
from app.adapters.outbound.postgres import models
from app.adapters.outbound.postgres.models import (
    AirlineReceiptRecord, Base, LedgerRecord, OperationRecord, OrderRecord, QuoteRecord, ServiceCaseRecord,
)
from app.adapters.outbound.postgres.seed import seed_demo_data
from app.application import fulfillment
from app.application.cases import service as case_service
from app.application.pricing import calculate


def _factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'airline-test.db'}")
    return engine, async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def _create_schema(engine):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


def test_airline_replay_survives_gateway_reconstruction(tmp_path):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        command = {"idempotency_key": "airline-replay-key", "order_id": "ORD-1", "action": "REFUND"}
        first = await MockAirlineGateway(delay_seconds=0, session_factory=factory).submit(command)
        replay = await MockAirlineGateway(delay_seconds=0, session_factory=factory).submit(command)
        reopened = MockAirlineGateway(delay_seconds=0, session_factory=factory)
        after_reopen = await reopened.submit(command)

        assert first["status"] == "ACCEPTED" and first["idempotent"] is False
        assert replay["supplier_reference"] == first["supplier_reference"]
        assert after_reopen["supplier_reference"] == first["supplier_reference"]
        assert replay["idempotent"] is True and after_reopen["idempotent"] is True
        assert (await reopened.find_by_idempotency_key(command["idempotency_key"]))["status"] == "ACCEPTED"
        await engine.dispose()
    asyncio.run(run())


def test_force_seed_does_not_reuse_pre_reset_airline_receipt(tmp_path):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        async with factory() as session:
            await seed_demo_data(session, force=True)
        gateway = MockAirlineGateway(session_factory=factory)
        command = {"idempotency_key": "reset-receipt-key"}

        first = await gateway.submit(command)
        async with factory() as session:
            await seed_demo_data(session, force=True)
        after_reset = await gateway.submit(command)

        assert first["idempotent"] is False
        assert after_reset["idempotent"] is False
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(AirlineReceiptRecord)) == 1
        await engine.dispose()
    asyncio.run(run())


def test_airline_rejected_and_timeout_injection_are_deterministic(tmp_path):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        gateway = MockAirlineGateway(delay_seconds=0, session_factory=factory, outcomes={
            "rejected-key": "REJECTED",
            "timeout-key": ["TIMEOUT", "ACCEPTED"],
        })
        rejected = await gateway.submit({"idempotency_key": "rejected-key"})
        rejected_replay = await gateway.submit({"idempotency_key": "rejected-key"})
        timeout = await gateway.submit({"idempotency_key": "timeout-key"})

        assert rejected["status"] == "REJECTED"
        assert rejected_replay == {**rejected, "idempotent": True}
        assert timeout["status"] == "TIMEOUT" and timeout["retryable"] is True
        assert await gateway.find_by_idempotency_key("timeout-key") is None
        assert (await gateway.submit({"idempotency_key": "timeout-key"}))["status"] == "ACCEPTED"
        await engine.dispose()
    asyncio.run(run())


async def _confirmed_operation(factory, key="fulfillment-key"):
    async with factory() as session:
        await seed_demo_data(session, force=True)
        order = await session.scalar(select(OrderRecord).where(
            OrderRecord.status == "ISSUED", OrderRecord.fare_product == "Y_DISCOUNT").limit(1))
        pricing = await calculate(session, order.order_id, "REFUND")
        now = datetime.now(timezone.utc)
        case = ServiceCaseRecord(case_id=f"case-{key}", user_id=order.user_id, order_id=order.order_id,
                                 status="PROCESSING", intent="REFUND", session_id=f"session-{key}",
                                 created_at=now, updated_at=now, current_quote_id=f"quote-{key}", result={})
        quote = QuoteRecord(quote_id=f"quote-{key}", case_id=case.case_id, order_id=order.order_id,
                            action="REFUND", amount=pricing["refund_amount"], currency="CNY",
                            details=[{"pricing": pricing}], policy_version="v1", benefit_version="v1",
                            status="CONFIRMED", expires_at=now, confirmed_at=now,
                            confirmation_id=f"confirmation-{key}", current_amount_at_review=pricing["refund_amount"],
                            platform_variance=0, created_at=now)
        operation = OperationRecord(operation_id=f"operation-{key}", idempotency_key=key,
                                    case_id=case.case_id, quote_id=quote.quote_id, order_id=order.order_id,
                                    action="REFUND", amount=pricing["refund_amount"], status="PENDING",
                                    request={}, response={}, created_at=now, updated_at=now)
        session.add_all([case, quote, operation])
        await session.commit()
        return operation.operation_id, quote.quote_id, order.order_id, quote.confirmation_id, order.user_id


def _patch_fulfillment(monkeypatch, factory):
    monkeypatch.setattr(fulfillment, "SessionFactory", factory)
    monkeypatch.setattr(case_service, "SessionFactory", factory)

    async def no_event(*args, **kwargs):
        return None
    monkeypatch.setattr(fulfillment, "record_case_event", no_event)
    monkeypatch.setattr(case_service, "record_case_event", no_event)


def test_fulfillment_replay_and_executed_quote_do_not_create_second_operation(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_fulfillment(monkeypatch, factory)
        operation_id, quote_id, order_id, confirmation_id, user_id = await _confirmed_operation(factory)
        gateway = MockAirlineGateway(delay_seconds=0, session_factory=factory)

        first = await fulfillment.fulfill_operation(operation_id, gateway)
        replay = await fulfillment.fulfill_operation(operation_id, gateway)
        confirmed = await case_service.create_confirmed_operation(
            quote_id, user_id, confirmation_id, "a-different-idempotency-key")

        assert first["status"] == "REFUNDED"
        assert replay["idempotent"] is True
        assert confirmed["idempotent"] is True and confirmed["operation_id"] == operation_id
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(OperationRecord)) == 1
            assert (await session.get(OrderRecord, order_id)).status == "REFUNDED"
            assert (await session.get(QuoteRecord, quote_id)).status == "EXECUTED"
        await engine.dispose()
    asyncio.run(run())


def test_fulfillment_rejected_does_not_mutate_order(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_fulfillment(monkeypatch, factory)
        operation_id, quote_id, order_id, _, _ = await _confirmed_operation(factory, "rejected-fulfillment")
        gateway = MockAirlineGateway(delay_seconds=0, session_factory=factory,
                                     outcomes={"rejected-fulfillment": "REJECTED"})

        result = await fulfillment.fulfill_operation(operation_id, gateway)

        assert result["status"] == "FAILED"
        async with factory() as session:
            assert (await session.get(OrderRecord, order_id)).status == "ISSUED"
            assert (await session.get(QuoteRecord, quote_id)).status == "CONFIRMED"
            assert (await session.get(OperationRecord, operation_id)).status == "FAILED"
            assert await session.scalar(select(func.count()).select_from(LedgerRecord)) == 0
        await engine.dispose()
    asyncio.run(run())


def test_fulfillment_timeout_is_unknown_and_retry_uses_same_operation(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_fulfillment(monkeypatch, factory)
        operation_id, quote_id, order_id, _, _ = await _confirmed_operation(factory, "timeout-fulfillment")
        gateway = MockAirlineGateway(delay_seconds=0, session_factory=factory,
                                     outcomes={"timeout-fulfillment": ["TIMEOUT", "ACCEPTED"]})

        unknown = await fulfillment.fulfill_operation(operation_id, gateway)

        assert unknown["status"] == "RESULT_UNKNOWN" and unknown["retryable"] is True
        async with factory() as session:
            assert (await session.get(OrderRecord, order_id)).status == "ISSUED"
            assert (await session.get(QuoteRecord, quote_id)).status == "CONFIRMED"
            assert (await session.get(OperationRecord, operation_id)).status == "RESULT_UNKNOWN"
            assert (await session.get(ServiceCaseRecord, f"case-timeout-fulfillment")).status == "RESULT_UNKNOWN"
            assert await session.scalar(select(func.count()).select_from(LedgerRecord)) == 0

        completed = await fulfillment.fulfill_operation(operation_id, gateway)
        assert completed["status"] == "REFUNDED" and completed["operation_id"] == operation_id
        async with factory() as session:
            assert (await session.get(OrderRecord, order_id)).status == "REFUNDED"
            assert await session.scalar(select(func.count()).select_from(OperationRecord)) == 1
        await engine.dispose()
    asyncio.run(run())
