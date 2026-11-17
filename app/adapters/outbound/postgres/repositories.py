"""SQLite 适配器对应的 SQLAlchemy 仓储实现。"""
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
    """用 SQLAlchemy 实现订单只读仓储；返回字典以隔离 ORM 对象。"""
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_order(self, order_id: str) -> dict | None:
        """按主键读取订单；不存在时返回空值。"""
        row = await self.session.get(OrderRecord, order_id)
        return _record_dict(row)

    async def list_orders(self, user_id: str) -> list[dict]:
        """按用户读取订单；日期和订单号保证稳定排序。"""
        result = await self.session.scalars(
            select(OrderRecord).where(OrderRecord.user_id == user_id).order_by(OrderRecord.date, OrderRecord.order_id)
        )
        return [_record_dict(row) for row in result]


class PostgresPolicyRepository:
    """用 SQLAlchemy 实现政策只读仓储；只暴露启用规则。"""
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_rule(self, rule_id: str) -> dict | None:
        """按主键读取规则；调用方自行判断是否为启用版本。"""
        return _record_dict(await self.session.get(RuleRecord, rule_id))

    async def list_rules(self, *, airline: str | None = None, cabin: str | None = None,
                         fare_product: str | None = None, scenario: str | None = None) -> list[dict]:
        """按业务维度和通配符筛选启用规则；结果按标识稳定排序。"""
        query = select(RuleRecord).where(RuleRecord.active.is_(True))
        for column, value in ((RuleRecord.airline, airline), (RuleRecord.cabin, cabin),
                              (RuleRecord.fare_product, fare_product), (RuleRecord.scenario, scenario)):
            if value:
                query = query.where(column.in_((value, "*")))
        result = await self.session.scalars(query.order_by(RuleRecord.id))
        return [_record_dict(row) for row in result]


class PostgresCaseRepository:
    """实现案件与案件事件持久化；更新不覆盖案件主键。"""
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get(self, case_id: str) -> dict | None:
        """按主键读取案件；不存在时返回空值。"""
        return _record_dict(await self.session.get(ServiceCaseRecord, case_id))

    async def save(self, case: dict) -> None:
        """新增或更新案件快照；实际提交由工作单元负责。"""
        row = await self.session.get(ServiceCaseRecord, case["case_id"])
        if row is None:
            self.session.add(ServiceCaseRecord(**case))
        else:
            for key, value in case.items():
                if key != "case_id":
                    setattr(row, key, value)

    async def append_event(self, case_id: str, event_type: str, payload: dict, created_at) -> None:
        """追加不可变案件事件；与业务状态可同事务提交。"""
        self.session.add(CaseEventRecord(case_id=case_id, event_type=event_type,
                                         payload=payload, created_at=created_at))


class PostgresQuoteRepository:
    """实现报价快照持久化；更新不覆盖报价主键。"""
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get(self, quote_id: str) -> dict | None:
        """按主键读取报价；不存在时返回空值。"""
        return _record_dict(await self.session.get(QuoteRecord, quote_id))

    async def save(self, quote: dict) -> None:
        """新增或更新报价快照；实际提交由工作单元负责。"""
        row = await self.session.get(QuoteRecord, quote["quote_id"])
        if row is None:
            self.session.add(QuoteRecord(**quote))
        else:
            for key, value in quote.items():
                if key != "quote_id":
                    setattr(row, key, value)


class PostgresOperationRepository:
    """实现办理记录持久化；幂等键查询与状态更新共享会话。"""
    def __init__(self, session: AsyncSession):
        self.session = session

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        """按唯一幂等键读取办理记录；用于请求重放。"""
        row = await self.session.scalar(select(OperationRecord).where(OperationRecord.idempotency_key == key))
        return _record_dict(row)

    async def create(self, operation: dict) -> dict:
        """插入办理记录并刷新数据库状态；唯一约束冲突由上层处理。"""
        row = OperationRecord(**operation)
        self.session.add(row)
        await self.session.flush()
        return _record_dict(row)

    async def update(self, operation: dict) -> None:
        """更新既有办理记录；主键不可改写，不存在时显式报错。"""
        row = await self.session.get(OperationRecord, operation["operation_id"])
        if row is None:
            raise LookupError(f"operation 不存在：{operation['operation_id']}")
        for key, value in operation.items():
            if key != "operation_id":
                setattr(row, key, value)


class PostgresOutboxRepository:
    """实现 Outbox 事件写入；与业务操作共享事务以避免状态丢失。"""
    def __init__(self, session: AsyncSession):
        self.session = session

    async def add(self, event_id: str, topic: str, aggregate_id: str, payload: dict, created_at) -> None:
        """追加待发布事件；发布时间由 worker 投递成功后单独回填。"""
        self.session.add(OutboxRecord(event_id=event_id, topic=topic, aggregate_id=aggregate_id,
                                      payload=payload, created_at=created_at))
