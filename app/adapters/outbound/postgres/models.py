"""SQLAlchemy 持久化记录；领域实体不依赖 ORM。"""
from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """定义 ORM 基类和 JSON 类型映射；领域实体因此无需继承数据库基类。"""
    type_annotation_map = {dict[str, Any]: JSON, list[dict[str, Any]]: JSON}


class ProfileRecord(Base):
    """持久化用户会员资料和偏好画像；画像 JSON 由 Agent 投影回写。"""
    __tablename__ = "profiles"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    tier: Mapped[str] = mapped_column(String(32), default="普通")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class FlightRecord(Base):
    """持久化航班计划、状态和分票种票价；航班号与日期共同唯一。"""
    __tablename__ = "flights"
    __table_args__ = (UniqueConstraint("flight_no", "date", name="uq_flight_no_date"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    flight_no: Mapped[str] = mapped_column(String(16), index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    airline: Mapped[str] = mapped_column(String(4))
    origin: Mapped[str] = mapped_column(String(8))
    dest: Mapped[str] = mapped_column(String(8))
    origin_city: Mapped[str] = mapped_column(String(80))
    dest_city: Mapped[str] = mapped_column(String(80))
    dep_time: Mapped[str] = mapped_column(String(8))
    duration_min: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="scheduled")
    delay_min: Mapped[int] = mapped_column(Integer, default=0)
    fares: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class OrderRecord(Base):
    """持久化用户订单和当前票号；退改履约直接更新其航班与状态。"""
    __tablename__ = "orders"

    order_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("profiles.user_id"), index=True)
    passenger: Mapped[str] = mapped_column(String(160))
    flight_no: Mapped[str] = mapped_column(String(16))
    date: Mapped[str] = mapped_column(String(10), index=True)
    airline: Mapped[str] = mapped_column(String(4))
    cabin: Mapped[str] = mapped_column(String(8))
    fare_product: Mapped[str] = mapped_column(String(40))
    fare: Mapped[int] = mapped_column(Integer)
    tax: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24), default="ISSUED")
    ticket_no: Mapped[str] = mapped_column(String(40))


class FeeRuleRecord(Base):
    """持久化航司票种费率表；与政策文本分离但由同一演示种子生成。"""
    __tablename__ = "fee_rules"
    __table_args__ = (UniqueConstraint("airline", "fare_product", name="uq_fee_rule_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    airline: Mapped[str] = mapped_column(String(4))
    fare_product: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict[str, Any]] = mapped_column(JSON)


class RuleRecord(Base):
    """持久化带版本和启用标记的政策规则；检索投影只同步启用版本。"""
    __tablename__ = "policy_rules"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    airline: Mapped[str] = mapped_column(String(4), index=True)
    cabin: Mapped[str] = mapped_column(String(8), default="*")
    fare_product: Mapped[str] = mapped_column(String(40), default="*", index=True)
    scenario: Mapped[str] = mapped_column(String(40), index=True)
    title: Mapped[str] = mapped_column(String(240))
    content: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)


class ServiceCaseRecord(Base):
    """持久化客服案件、会话绑定和最新结果；当前报价字段指向最新确认上下文。"""
    __tablename__ = "service_cases"
    __table_args__ = (Index("ix_case_user_created", "user_id", "created_at"),)

    case_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("profiles.user_id"))
    order_id: Mapped[str | None] = mapped_column(ForeignKey("orders.order_id"), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="OPEN")
    intent: Mapped[str | None] = mapped_column(String(32), nullable=True)
    session_id: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    current_quote_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class CaseEventRecord(Base):
    """持久化案件运行事件；流标识发布后回填，支持 SSE 断点续传。"""
    __tablename__ = "case_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("service_cases.case_id"), index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stream_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class QuoteRecord(Base):
    """持久化报价、确认快照和价格复核结果；确认号唯一以防止重复绑定。"""
    __tablename__ = "quotes"

    quote_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("service_cases.case_id"), index=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.order_id"), index=True)
    action: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    details: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    policy_version: Mapped[str] = mapped_column(String(80))
    benefit_version: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(32), default="OFFERED")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmation_id: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    current_amount_at_review: Mapped[int | None] = mapped_column(Integer, nullable=True)
    platform_variance: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OperationRecord(Base):
    """持久化办理请求、状态和响应；幂等键唯一，终态重放不会再次出票。"""
    __tablename__ = "operations"

    operation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("service_cases.case_id"), index=True)
    quote_id: Mapped[str] = mapped_column(ForeignKey("quotes.quote_id"), unique=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.order_id"), index=True)
    action: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    request: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    response: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AirlineReceiptRecord(Base):
    """按幂等键保存模拟航司回执；数据库唯一约束兜底并发重复提交。"""
    __tablename__ = "airline_receipts"

    idempotency_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    receipt: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LedgerRecord(Base):
    """持久化乘客、航司和平台分录；金额符号表示各账户的资金方向。"""
    __tablename__ = "ledger_entries"

    entry_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    operation_id: Mapped[str] = mapped_column(ForeignKey("operations.operation_id"), index=True)
    account: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    reason: Mapped[str] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OutboxRecord(Base):
    """持久化待发布业务事件；业务提交后由 worker 投递并回填发布时间。"""
    __tablename__ = "outbox_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    topic: Mapped[str] = mapped_column(String(100), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class EvaluationRunRecord(Base):
    """持久化评测运行状态、进度和报告；用例快照保存在进度内部。"""
    __tablename__ = "evaluation_runs"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), default="QUEUED")
    mode: Mapped[str] = mapped_column(String(24), default="offline")
    progress: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    report: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class EvaluationCaseSetRecord(Base):
    """持久化不可变评测用例集版本；运行记录通过版本追溯输入。"""
    __tablename__ = "evaluation_case_sets"

    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    cases: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(64))


class AuditRecord(Base):
    """持久化确认、重报价和履约审计；记录操作者、资源和关键金额证据。"""
    __tablename__ = "audit_events"

    audit_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(100), index=True)
    resource_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
