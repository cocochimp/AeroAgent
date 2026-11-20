import asyncio
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.outbound.airline.mock import MockAirlineGateway
from app.adapters.outbound.persistence.models import (
    Base, LedgerRecord, OperationRecord, OrderRecord, QuoteRecord, ServiceCaseRecord,
)
from app.adapters.outbound.persistence.seed import seed_demo_data
from app.adapters.outbound.sqlite import data as agent_data
from app.application import fulfillment
from app.application.agents.transaction_agent import ConfirmedQuoteCommand, TicketTransactionAgent
from app.application.cases import service as quote_service
from app.application.pricing import calculate


async def _offered_quote(factory, key):
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
        session.add_all([case, quote])
        await session.commit()
        return quote.quote_id, order.order_id, order.user_id


def _patch_business_db(monkeypatch, factory):
    monkeypatch.setattr(fulfillment, "SessionFactory", factory)
    monkeypatch.setattr(quote_service, "SessionFactory", factory)

    async def no_event(*args, **kwargs):
        return None

    monkeypatch.setattr(fulfillment, "record_case_event", no_event)
    monkeypatch.setattr(quote_service, "record_case_event", no_event)


def test_quote_api_and_transaction_agent_fulfill_with_idempotency(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'transaction.db'}")
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        _patch_business_db(monkeypatch, factory)
        quote_id, order_id, user_id = await _offered_quote(factory, "transaction-success")
        agent_data.init()
        legacy_order = agent_data.list_orders()[0]
        legacy_before = agent_data.get_order(legacy_order["order_id"])

        confirmed = await quote_service.create_confirmed_operation(
            quote_id, user_id, "confirmation-transaction-success", "transaction-success")
        gateway = MockAirlineGateway(delay_seconds=0, session_factory=factory)
        agent = TicketTransactionAgent(airline=gateway)
        first = await agent.execute(ConfirmedQuoteCommand(confirmed["operation_id"]))
        replay = await agent.execute(ConfirmedQuoteCommand(confirmed["operation_id"]))

        assert confirmed["status"] == "ACCEPTED"
        assert first["status"] == "REFUNDED" and first["ticket_no"].startswith("781-")
        assert replay["idempotent"] is True and replay["operation_id"] == confirmed["operation_id"]
        async with factory() as session:
            assert (await session.get(OrderRecord, order_id)).status == "REFUNDED"
            assert (await session.get(QuoteRecord, quote_id)).status == "EXECUTED"
            assert await session.scalar(select(func.count()).select_from(OperationRecord)) == 1
            assert await session.scalar(select(func.count()).select_from(LedgerRecord)) == 2
        assert agent_data.get_order(legacy_order["order_id"]) == legacy_before
        await engine.dispose()

    asyncio.run(run())


def test_transaction_agent_rejection_does_not_mutate_business_or_agent_orders(tmp_path, monkeypatch):
    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'transaction-rejected.db'}")
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        _patch_business_db(monkeypatch, factory)
        quote_id, order_id, user_id = await _offered_quote(factory, "transaction-rejected")
        agent_data.init()
        legacy_order = agent_data.list_orders()[0]
        legacy_before = agent_data.get_order(legacy_order["order_id"])
        confirmed = await quote_service.create_confirmed_operation(
            quote_id, user_id, "confirmation-transaction-rejected", "transaction-rejected")
        gateway = MockAirlineGateway(delay_seconds=0, session_factory=factory,
                                     outcomes={"transaction-rejected": "REJECTED"})

        result = await TicketTransactionAgent(airline=gateway).execute(
            ConfirmedQuoteCommand(confirmed["operation_id"]))

        assert result["status"] == "FAILED"
        async with factory() as session:
            assert (await session.get(OrderRecord, order_id)).status == "ISSUED"
            assert (await session.get(QuoteRecord, quote_id)).status == "CONFIRMED"
            assert (await session.get(OperationRecord, confirmed["operation_id"])).status == "FAILED"
            assert await session.scalar(select(func.count()).select_from(LedgerRecord)) == 0
        assert agent_data.get_order(legacy_order["order_id"]) == legacy_before
        await engine.dispose()

    asyncio.run(run())


def test_transaction_agent_requires_persisted_operation_id():
    with pytest.raises(ValueError, match="operation_id"):
        asyncio.run(TicketTransactionAgent().execute(ConfirmedQuoteCommand("")))
