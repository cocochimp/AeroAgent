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
    """为历史订单回填 UTC 时间和 CNY，并创建预订、观测和提醒表。

    SQLite 不能原地改列约束，且 `orders` 被 `service_cases.order_id` 外键引用，
    batch 重建会触发 FOREIGN KEY 约束失败。因此这里只做增量列 + 幂等回填；
    非空约束只在支持 ALTER 的数据库上收紧。
    """
    bind = op.get_bind()
    sqlite = bind.dialect.name == "sqlite"
    # 0001 以当前 ORM metadata 建表；全新升级时这些列已存在，历史 0002 库则需要增量添加。
    columns = {column["name"] for column in sa.inspect(bind).get_columns("orders")}
    if "created_at" not in columns:
        op.add_column("orders", sa.Column("created_at", sa.DateTime(timezone=True), nullable=True))
    if "updated_at" not in columns:
        op.add_column("orders", sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True))
    if "currency" not in columns:
        op.add_column("orders", sa.Column("currency", sa.String(length=3), nullable=False,
                                          server_default="CNY"))
    if "paid_at" not in columns:
        op.add_column("orders", sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True))
    # 回填必须无条件且幂等：失败重跑后历史行仍可能为空，不能只看列是否存在。
    op.execute("UPDATE orders SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL")
    op.execute("UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL")
    if not sqlite:
        op.alter_column("orders", "created_at", existing_type=sa.DateTime(timezone=True),
                        nullable=False, server_default=sa.text("CURRENT_TIMESTAMP"))
        op.alter_column("orders", "updated_at", existing_type=sa.DateTime(timezone=True),
                        nullable=False, server_default=sa.text("CURRENT_TIMESTAMP"))
    order_indexes = {index["name"] for index in sa.inspect(bind).get_indexes("orders")}
    if "ix_orders_user_created" not in order_indexes:
        op.create_index("ix_orders_user_created", "orders", ["user_id", "created_at"])
    flight_indexes = {index["name"] for index in sa.inspect(bind).get_indexes("flights")}
    if "ix_flight_route_date" not in flight_indexes:
        op.create_index("ix_flight_route_date", "flights", ["origin", "dest", "date"])
    for model in (BookingAttemptRecord, PriceWatchRecord, PriceObservationRecord, PriceAlertRecord):
        model.__table__.create(bind=bind, checkfirst=True)


def downgrade():
    """删除本迁移新增的监控和预订数据；SQLite 保留增量列，避免重建被外键引用的订单表。"""
    bind = op.get_bind()
    for model in (PriceAlertRecord, PriceObservationRecord, PriceWatchRecord, BookingAttemptRecord):
        model.__table__.drop(bind=bind, checkfirst=True)
    for name, table in (("ix_flight_route_date", "flights"), ("ix_orders_user_created", "orders")):
        try:
            op.drop_index(name, table_name=table)
        except Exception:                      # noqa: BLE001 - 索引可能从未创建
            pass
    if bind.dialect.name != "sqlite":
        for column in ("paid_at", "currency", "updated_at", "created_at"):
            op.drop_column("orders", column)
