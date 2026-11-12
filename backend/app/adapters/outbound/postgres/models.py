"""SQLAlchemy persistence records. Domain entities stay free of ORM concerns."""
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    type_annotation_map = {dict[str, Any]: JSONB, list[dict[str, Any]]: JSONB}


class ProfileRecord(Base):
    __tablename__ = "profiles"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    tier: Mapped[str] = mapped_column(String(32), default="普通")
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class FlightRecord(Base):
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
    fares: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class OrderRecord(Base):
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
    __tablename__ = "fee_rules"
    __table_args__ = (UniqueConstraint("airline", "fare_product", name="uq_fee_rule_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    airline: Mapped[str] = mapped_column(String(4))
    fare_product: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict[str, Any]] = mapped_column(JSONB)


class RuleRecord(Base):
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
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class CaseEventRecord(Base):
    __tablename__ = "case_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("service_cases.case_id"), index=True)
    event_type: Mapped[str] = mapped_column(String(80))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    stream_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class QuoteRecord(Base):
    __tablename__ = "quotes"

    quote_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("service_cases.case_id"), index=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.order_id"), index=True)
    action: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    details: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
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
    __tablename__ = "operations"

    operation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(String(128), unique=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("service_cases.case_id"), index=True)
    quote_id: Mapped[str] = mapped_column(ForeignKey("quotes.quote_id"), index=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.order_id"), index=True)
    action: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    request: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    response: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class LedgerRecord(Base):
    __tablename__ = "ledger_entries"

    entry_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    operation_id: Mapped[str] = mapped_column(ForeignKey("operations.operation_id"), index=True)
    account: Mapped[str] = mapped_column(String(24))
    amount: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(3), default="CNY")
    reason: Mapped[str] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OutboxRecord(Base):
    __tablename__ = "outbox_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    topic: Mapped[str] = mapped_column(String(100), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class EvaluationRunRecord(Base):
    __tablename__ = "evaluation_runs"

    run_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), default="QUEUED")
    mode: Mapped[str] = mapped_column(String(24), default="offline")
    progress: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    report: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class EvaluationCaseSetRecord(Base):
    __tablename__ = "evaluation_case_sets"

    version: Mapped[str] = mapped_column(String(64), primary_key=True)
    cases: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str] = mapped_column(String(64))


class AuditRecord(Base):
    __tablename__ = "audit_events"

    audit_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    actor_id: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(100), index=True)
    resource_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
