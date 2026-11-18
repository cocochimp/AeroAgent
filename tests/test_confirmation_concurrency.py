import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.outbound.postgres import database
from app.adapters.outbound.postgres.models import (
    Base, OperationRecord, OrderRecord, OutboxRecord, QuoteRecord, ServiceCaseRecord,
)
from app.adapters.outbound.postgres.seed import seed_demo_data
from app.application.cases import service as case_service
from app.application.pricing import calculate


def _factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'confirmation-test.db'}")

    @event.listens_for(engine.sync_engine, "connect")
    def configure_sqlite(dbapi_connection, _):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    return engine, async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def _create_schema(engine):
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)


async def _create_offered_quote(factory, key):
    async with factory() as session:
        await seed_demo_data(session, force=True)
        order = await session.scalar(select(OrderRecord).where(
            OrderRecord.status == "ISSUED", OrderRecord.fare_product == "Y_DISCOUNT").limit(1))
        pricing = await calculate(session, order.order_id, "REFUND")
        now = datetime.now(timezone.utc)
        case = ServiceCaseRecord(case_id=f"case-{key}", user_id=order.user_id, order_id=order.order_id,
                                 status="WAITING_CONFIRMATION", intent="REFUND", session_id=f"session-{key}",
                                 created_at=now, updated_at=now, current_quote_id=f"quote-{key}", result={})
        quote = QuoteRecord(quote_id=f"quote-{key}", case_id=case.case_id, order_id=order.order_id,
                            action="REFUND", amount=pricing["refund_amount"], currency="CNY",
                            details=[{"pricing": pricing}], policy_version="v1", benefit_version="v1",
                            status="OFFERED", expires_at=now, created_at=now)
        session.add(case)
        await session.flush()
        session.add(quote)
        await session.commit()
        return quote.quote_id, order.user_id


def _patch_service(monkeypatch, factory):
    monkeypatch.setattr(case_service, "SessionFactory", factory)

    async def no_event(*args, **kwargs):
        return None

    monkeypatch.setattr(case_service, "record_case_event", no_event)


async def _gather_confirmations(monkeypatch, quote_id, user_id, requests):
    original_calculate = case_service.calculate
    barrier = asyncio.Barrier(len(requests))

    async def synchronized_calculate(*args, **kwargs):
        pricing = await original_calculate(*args, **kwargs)
        await barrier.wait()
        return pricing

    monkeypatch.setattr(case_service, "calculate", synchronized_calculate)
    return await asyncio.wait_for(asyncio.gather(*(
        case_service.create_confirmed_operation(quote_id, user_id, confirmation_id, idempotency_key)
        for confirmation_id, idempotency_key in requests
    ), return_exceptions=True), timeout=10)


async def _insert_duplicate_operations(engine):
    async with engine.begin() as connection:
        for suffix in ("one", "two"):
            await connection.execute(text("""
                INSERT INTO operations (
                    operation_id, idempotency_key, case_id, quote_id, order_id, action,
                    amount, status, request, response, created_at, updated_at
                ) VALUES (
                    :operation_id, :idempotency_key, 'case-unique', 'quote-unique', 'order-unique', 'REFUND',
                    300, 'PENDING', '{}', '{}', '2026-01-01 00:00:00', '2026-01-01 00:00:00'
                )
            """), {"operation_id": f"operation-{suffix}", "idempotency_key": f"key-{suffix}"})


def test_same_confirmation_concurrency_reuses_one_operation_and_outbox(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_service(monkeypatch, factory)
        quote_id, user_id = await _create_offered_quote(factory, "same-confirmation")

        results = await _gather_confirmations(monkeypatch, quote_id, user_id, [
            ("confirmation-shared", "key-one"), ("confirmation-shared", "key-two"),
        ])

        assert all(isinstance(result, dict) for result in results), results
        assert results[0]["operation_id"] == results[1]["operation_id"]
        assert [result["idempotent"] for result in results].count(False) == 1
        assert [result["idempotent"] for result in results].count(True) == 1
        replay = next(result for result in results if result["idempotent"])
        assert replay["status"] == "PENDING"
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(OperationRecord)) == 1
            assert await session.scalar(select(func.count()).select_from(OutboxRecord)) == 1
        await engine.dispose()

    asyncio.run(run())


def test_different_confirmation_concurrency_rejects_loser(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_service(monkeypatch, factory)
        quote_id, user_id = await _create_offered_quote(factory, "different-confirmation")
        requests = [("confirmation-one", "key-one"), ("confirmation-two", "key-two")]

        results = await _gather_confirmations(monkeypatch, quote_id, user_id, requests)

        responses = [result for result in results if isinstance(result, dict)]
        errors = [result for result in results if isinstance(result, Exception)]
        assert len(responses) == 1 and len(errors) == 1, results
        assert isinstance(errors[0], ValueError)
        assert "其他确认请求" in str(errors[0])
        winner = results.index(responses[0])
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(OperationRecord)) == 1
            assert await session.scalar(select(func.count()).select_from(OutboxRecord)) == 1
            quote = await session.get(QuoteRecord, quote_id)
            assert quote.confirmation_id == requests[winner][0]
        await engine.dispose()

    asyncio.run(run())


def test_confirmed_replay_returns_actual_operation_status_and_id(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_service(monkeypatch, factory)
        quote_id, user_id = await _create_offered_quote(factory, "confirmed-replay")
        first = await case_service.create_confirmed_operation(
            quote_id, user_id, "confirmation-replay", "key-original")
        async with factory() as session:
            operation = await session.get(OperationRecord, first["operation_id"])
            operation.status = "FAILED"
            await session.commit()

        replay = await case_service.create_confirmed_operation(
            quote_id, user_id, "confirmation-replay", "key-different")

        assert replay == {"status": "FAILED", "operation_id": first["operation_id"],
                          "quote_id": quote_id, "amount": first["amount"], "idempotent": True}
        await engine.dispose()

    asyncio.run(run())


def test_alternative_quotes_share_one_case_operation(tmp_path, monkeypatch):
    async def run():
        engine, factory = _factory(tmp_path)
        await _create_schema(engine)
        _patch_service(monkeypatch, factory)
        async with factory() as session:
            await seed_demo_data(session, force=True)
            order = await session.scalar(select(OrderRecord).where(OrderRecord.status == "ISSUED").limit(1))
            pricing = await calculate(session, order.order_id, "REFUND")
            now = datetime.now(timezone.utc)
            case = ServiceCaseRecord(case_id="case-alternatives", user_id=order.user_id,
                order_id=order.order_id, status="WAITING_CONFIRMATION", intent="REFUND",
                session_id="session-alternatives", created_at=now, updated_at=now,
                current_quote_id="quote-a", result={})
            session.add(case)
            await session.flush()
            for quote_id in ("quote-a", "quote-b"):
                session.add(QuoteRecord(quote_id=quote_id, case_id=case.case_id,
                    order_id=order.order_id, action="REFUND", amount=pricing["refund_amount"],
                    currency="CNY", details=[{"pricing": pricing}], policy_version="v1",
                    benefit_version="v1", status="OFFERED", expires_at=now, created_at=now))
            await session.commit()
            user_id = order.user_id

        original_calculate = case_service.calculate
        barrier = asyncio.Barrier(2)

        async def synchronized_calculate(*args, **kwargs):
            result = await original_calculate(*args, **kwargs)
            await barrier.wait()
            return result

        monkeypatch.setattr(case_service, "calculate", synchronized_calculate)
        results = await asyncio.gather(
            case_service.create_confirmed_operation("quote-a", user_id, "confirmation-a", "key-a"),
            case_service.create_confirmed_operation("quote-b", user_id, "confirmation-b", "key-b"),
            return_exceptions=True,
        )

        responses = [result for result in results if isinstance(result, dict)]
        errors = [result for result in results if isinstance(result, Exception)]
        assert len(responses) == 1 and len(errors) == 1, results
        assert isinstance(errors[0], ValueError)
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(OperationRecord)) == 1
            assert await session.scalar(select(func.count()).select_from(OutboxRecord)) == 1
            current_case = await session.get(ServiceCaseRecord, "case-alternatives")
            quotes = {quote.quote_id: quote for quote in (
                await session.get(QuoteRecord, "quote-a"), await session.get(QuoteRecord, "quote-b"))}
            assert current_case.current_quote_id in {"quote-a", "quote-b"}
            assert quotes[current_case.current_quote_id].status == "CONFIRMED"
            other = next(quote_id for quote_id in quotes if quote_id != current_case.current_quote_id)
            assert quotes[other].status == "CANCELLED"
        await engine.dispose()

    asyncio.run(run())


def test_new_schema_rejects_two_operations_for_one_quote(tmp_path):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'new-schema.db'}")
        await _create_schema(engine)

        with pytest.raises(IntegrityError):
            await _insert_duplicate_operations(engine)
        await engine.dispose()

    asyncio.run(run())


def test_initialize_schema_upgrades_existing_database_with_unique_quote_index(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'existing-schema.db'}")
        await _create_schema(engine)
        async with engine.begin() as connection:
            await connection.execute(text("DROP INDEX IF EXISTS uq_operations_quote_id"))
            await connection.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_operations_quote_id ON operations (quote_id)"))
        monkeypatch.setattr(database, "engine", engine)

        await database.initialize_schema()
        await database.initialize_schema()

        with pytest.raises(IntegrityError):
            await _insert_duplicate_operations(engine)
        await engine.dispose()

    asyncio.run(run())
