"""持久化模拟航司回执以支持幂等重放。

Revision ID: 0002_airline_receipts
"""
from alembic import op

from app.adapters.outbound.persistence.models import AirlineReceiptRecord

revision = "0002_airline_receipts"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    """创建航司回执表；幂等键主键支撑并发办理结果重放。"""
    AirlineReceiptRecord.__table__.create(bind=op.get_bind(), checkfirst=True)


def downgrade():
    """删除航司回执表；回滚后将丢失模拟航司幂等记录。"""
    AirlineReceiptRecord.__table__.drop(bind=op.get_bind(), checkfirst=True)
