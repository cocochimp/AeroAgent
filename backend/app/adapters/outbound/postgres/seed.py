"""Seed the documented fictional airline dataset into PostgreSQL."""
from datetime import datetime, timezone

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from air_agent.demo_data import load_demo_seed

from .models import (AuditRecord, CaseEventRecord, EvaluationCaseSetRecord, EvaluationRunRecord,
                     FeeRuleRecord, FlightRecord, LedgerRecord, OperationRecord, OrderRecord,
                     OutboxRecord, ProfileRecord, QuoteRecord, RuleRecord, ServiceCaseRecord)


async def seed_demo_data(session: AsyncSession, *, force: bool = False) -> None:
    if not force and await session.scalar(select(ProfileRecord.user_id).limit(1)):
        return
    if force:
        # Reset transaction/demo state while retaining audit trails and evaluation history.
        for model in (LedgerRecord, OperationRecord, QuoteRecord, CaseEventRecord,
                      ServiceCaseRecord, OutboxRecord, OrderRecord, FlightRecord,
                      FeeRuleRecord, RuleRecord, ProfileRecord):
            await session.execute(delete(model))
    now = datetime.now(timezone.utc)
    fixture = load_demo_seed(now)
    session.add_all([ProfileRecord(**p) for p in fixture["profiles"]])
    session.add_all([FlightRecord(**f) for f in fixture["flights"]])
    session.add_all([OrderRecord(**o) for o in fixture["orders"]])
    session.add_all([FeeRuleRecord(airline=row["airline"], fare_product=row["fare_product"], data=row["data"])
                     for row in fixture["fee_rules"]])
    session.add_all([RuleRecord(**{**rule, "version": 1, "active": True,
                                   "updated_at": now}) for rule in fixture["policy_rules"]])
    await session.commit()
