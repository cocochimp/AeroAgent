"""Repository implementations for the PostgreSQL adapter."""
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    CaseEventRecord,
    OperationRecord,
    OrderRecord,
    OutboxRecord,
    QuoteRecord,
    RuleRecord,
    ServiceCaseRecord,
)


def _record_dict(record: Any) -> dict | None:
    if record is None:
        return None
    return {column.name: getattr(record, column.name) for column in record.__table__.columns}


class PostgresOrderRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_order(self, order_id: str) -> dict | None:
        row = await self.session.get(OrderRecord, order_id)
        return _record_dict(row)

    async def list_orders(self, user_id: str) -> list[dict]:
        result = await self.session.scalars(
            select(OrderRecord).where(OrderRecord.user_id == user_id).order_by(OrderRecord.date, OrderRecord.order_id)
        )
        return [_record_dict(row) for row in result]


class PostgresPolicyRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_rule(self, rule_id: str) -> dict | None:
        return _record_dict(await self.session.get(RuleRecord, rule_id))

    async def list_rules(self, *, airline: str | None = None, cabin: str | None = None,
                         fare_product: str | None = None, scenario: str | None = None) -> list[dict]:
        query = select(RuleRecord).where(RuleRecord.active.is_(True))
        for column, value in ((RuleRecord.airline, airline), (RuleRecord.cabin, cabin),
                              (RuleRecord.fare_product, fare_product), (RuleRecord.scenario, scenario)):
            if value:
                query = query.where(column.in_((value, "*")))
        result = await self.session.scalars(query.order_by(RuleRecord.id))
        return [_record_dict(row) for row in result]


class PostgresCaseRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get(self, case_id: str) -> dict | None:
        return _record_dict(await self.session.get(ServiceCaseRecord, case_id))

    async def save(self, case: dict) -> None:
        row = await self.session.get(ServiceCaseRecord, case["case_id"])
        if row is None:
            self.session.add(ServiceCaseRecord(**case))
        else:
            for key, value in case.items():
                if key != "case_id":
                    setattr(row, key, value)

    async def append_event(self, case_id: str, event_type: str, payload: dict, created_at) -> None:
        self.session.add(CaseEventRecord(case_id=case_id, event_type=event_type,
                                         payload=payload, created_at=created_at))


class PostgresQuoteRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get(self, quote_id: str) -> dict | None:
        return _record_dict(await self.session.get(QuoteRecord, quote_id))

    async def save(self, quote: dict) -> None:
        row = await self.session.get(QuoteRecord, quote["quote_id"])
        if row is None:
            self.session.add(QuoteRecord(**quote))
        else:
            for key, value in quote.items():
                if key != "quote_id":
                    setattr(row, key, value)


class PostgresOperationRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        row = await self.session.scalar(select(OperationRecord).where(OperationRecord.idempotency_key == key))
        return _record_dict(row)

    async def create(self, operation: dict) -> dict:
        row = OperationRecord(**operation)
        self.session.add(row)
        await self.session.flush()
        return _record_dict(row)

    async def update(self, operation: dict) -> None:
        row = await self.session.get(OperationRecord, operation["operation_id"])
        if row is None:
            raise LookupError(f"operation 不存在：{operation['operation_id']}")
        for key, value in operation.items():
            if key != "operation_id":
                setattr(row, key, value)


class PostgresOutboxRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def add(self, event_id: str, topic: str, aggregate_id: str, payload: dict, created_at) -> None:
        self.session.add(OutboxRecord(event_id=event_id, topic=topic, aggregate_id=aggregate_id,
                                      payload=payload, created_at=created_at))
