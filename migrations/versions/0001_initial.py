"""初始 DDD 客服业务表结构。

Revision ID: 0001_initial
"""
from alembic import op

from app.adapters.outbound.postgres.models import Base

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    """创建初始客服、报价、履约和评测表结构；以 ORM 元数据为唯一表定义。"""
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade():
    """删除初始迁移创建的全部表；仅用于明确回滚整个业务 schema。"""
    bind = op.get_bind()
    Base.metadata.drop_all(bind=bind)
