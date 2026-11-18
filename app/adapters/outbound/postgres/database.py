"""异步 SQLite 引擎和请求级会话依赖。"""
import os
from collections.abc import AsyncIterator

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import config as settings

from .models import Base


DATABASE_URL = os.getenv("DATABASE_URL") or f"sqlite+aiosqlite:///{settings.VAR_DIR / 'aeroagent.db'}"
engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


if engine.url.get_backend_name() == "sqlite":
    @event.listens_for(engine.sync_engine, "connect")
    def _configure_sqlite(dbapi_connection, _):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()


async def get_session() -> AsyncIterator[AsyncSession]:
    """提供请求级异步数据库会话；上下文退出时自动释放连接。"""
    async with SessionFactory() as session:
        yield session


def _upgrade_lite_schema(connection) -> None:
    """给历史 SQLite 表原地补列；不能用 batch 重建被案件外键引用的订单表。"""
    columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(orders)")}
    additions = {
        "created_at": "DATETIME",
        "updated_at": "DATETIME",
        "currency": "VARCHAR(3) NOT NULL DEFAULT 'CNY'",
        "paid_at": "DATETIME",
    }
    for name, definition in additions.items():
        if name not in columns:
            connection.exec_driver_sql(f"ALTER TABLE orders ADD COLUMN {name} {definition}")
    connection.exec_driver_sql(
        "UPDATE orders SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL")
    connection.exec_driver_sql(
        "UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL")
    connection.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_orders_user_created ON orders (user_id, created_at)")
    connection.exec_driver_sql(
        "CREATE INDEX IF NOT EXISTS ix_flight_route_date ON flights (origin, dest, date)")


async def initialize_schema() -> None:
    """lite 部署先建缺失表，再幂等执行增量迁移升级历史库。"""
    if engine.url.get_backend_name() == "sqlite" and engine.url.database:
        from pathlib import Path
        Path(engine.url.database).parent.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        if engine.url.get_backend_name() == "sqlite":
            await connection.run_sync(_upgrade_lite_schema)
            # create_all 不会给历史库补唯一约束，用幂等唯一索引保证单报价单操作
            await connection.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_operations_quote_id ON operations (quote_id)"))
