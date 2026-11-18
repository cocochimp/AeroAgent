"""增加订单时间/币种、预订支付幂等记录与持久化价格监控。

Revision ID: 0003_order_booking_watches
"""
import sqlalchemy as sa
from alembic import op

from app.adapters.outbound.postgres.models import (
    BookingAttemptRecord,
    PriceAlertRecord,
    PriceObservationRecord,
    PriceWatchRecord,
)

revision = "0003_order_booking_watches"
down_revision = "0002_airline_receipts"
branch_labels = None
depends_on = None


def upgrade():
    """为历史订单回填 UTC 时间和 CNY，并创建预订、观测和提醒表。"""
    bind = op.get_bind()
    # 0001 以当前 ORM metadata 建表；全新升级时这些列已存在，历史 0002 库则需要增量添加。
    columns = {column["name"] for column in sa.inspect(bind).get_columns("orders")}
    added_timestamps = False
    # SQLite 禁止 ADD COLUMN 使用 CURRENT_TIMESTAMP；先回填，再通过 batch 重建恢复非空默认值。
    if "created_at" not in columns:
        op.add_column("orders", sa.Column("created_at", sa.DateTime(timezone=True), nullable=True))
        added_timestamps = True
    if "updated_at" not in columns:
        op.add_column("orders", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
        added_timestamps = True
    if "currency" not in columns:
        op.add_column("orders", sa.Column("currency", sa.String(length=3), nullable=False,
                                          server_default="CNY"))
    if "paid_at" not in columns:
        op.add_column("orders", sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True))
    if added_timestamps:
        op.execute("UPDATE orders SET created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP "
                   "WHERE created_at IS NULL OR updated_at IS NULL")
        with op.batch_alter_table("orders") as batch:
            batch.alter_column("created_at", existing_type=sa.DateTime(timezone=True), nullable=False,
                               server_default=sa.text("CURRENT_TIMESTAMP"))
            batch.alter_column("updated_at", existing_type=sa.DateTime(timezone=True), nullable=False,
                               server_default=sa.text("CURRENT_TIMESTAMP"))
    order_indexes = {index["name"] for index in sa.inspect(bind).get_indexes("orders")}
    if "ix_orders_user_created" not in order_indexes:
        op.create_index("ix_orders_user_created", "orders", ["user_id", "created_at"])
    flight_indexes = {index["name"] for index in sa.inspect(bind).get_indexes("flights")}
    if "ix_flight_route_date" not in flight_indexes:
        op.create_index("ix_flight_route_date", "flights", ["origin", "dest", "date"])
    for model in (BookingAttemptRecord, PriceWatchRecord, PriceObservationRecord, PriceAlertRecord):
        model.__table__.create(bind=bind, checkfirst=True)


def downgrade():
    """删除本迁移新增的监控和预订数据，再移除订单字段与索引。"""
    bind = op.get_bind()
    for model in (PriceAlertRecord, PriceObservationRecord, PriceWatchRecord, BookingAttemptRecord):
        model.__table__.drop(bind=bind, checkfirst=True)
    op.drop_index("ix_flight_route_date", table_name="flights")
    op.drop_index("ix_orders_user_created", table_name="orders")
    op.drop_column("orders", "paid_at")
    op.drop_column("orders", "currency")
    op.drop_column("orders", "updated_at")
    op.drop_column("orders", "created_at")
