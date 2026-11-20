"""向 SQLite 写入文档配套的虚构航司数据。"""
from app import config as S

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.demo_data import load_demo_seed

from .models import (AirlineReceiptRecord, AuditRecord, BookingAttemptRecord, CaseEventRecord,
                     EvaluationCaseSetRecord, EvaluationRunRecord, FeeRuleRecord, FlightRecord,
                     LedgerRecord, OperationRecord, OrderRecord, OutboxRecord, PriceAlertRecord,
                     PriceObservationRecord, PriceWatchRecord, ProfileRecord, QuoteRecord, RuleRecord,
                     ServiceCaseRecord)


async def seed_demo_data(session: AsyncSession, *, force: bool = False) -> None:
    """写入虚构航司演示数据；强制重置保留审计和评测历史，其余交易状态清空。"""
    if not force and await session.scalar(select(ProfileRecord.user_id).limit(1)):
        return
    if force:
        # 重置交易与演示状态，但保留审计轨迹和评测历史。
        # 先删引用订单/案件的子表，再删主表，避免外键阻塞演示重置。
        for model in (PriceAlertRecord, PriceObservationRecord, PriceWatchRecord, BookingAttemptRecord,
                      LedgerRecord, OperationRecord, QuoteRecord, CaseEventRecord,
                      ServiceCaseRecord, OutboxRecord, OrderRecord, FlightRecord,
                      FeeRuleRecord, RuleRecord, ProfileRecord, AirlineReceiptRecord):
            await session.execute(delete(model))
    now = S.now()
    fixture = load_demo_seed(now)
    session.add_all([ProfileRecord(**p) for p in fixture["profiles"]])
    await session.flush()
    session.add_all([FlightRecord(**f) for f in fixture["flights"]])
    session.add_all([OrderRecord(**o) for o in fixture["orders"]])
    session.add_all([FeeRuleRecord(airline=row["airline"], fare_product=row["fare_product"], data=row["data"])
                     for row in fixture["fee_rules"]])
    session.add_all([RuleRecord(**{**rule, "version": 1, "active": True,
                                   "updated_at": now}) for rule in fixture["policy_rules"]])
    await session.commit()
