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


async def initialize_schema() -> None:
    """lite 部署以 ORM 元数据为表结构事实来源。"""
    if engine.url.get_backend_name() == "sqlite" and engine.url.database:
        from pathlib import Path
        Path(engine.url.database).parent.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        if engine.url.get_backend_name() == "sqlite":
            # create_all 不会给历史库补唯一约束，用幂等唯一索引保证单报价单操作
            await connection.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_operations_quote_id ON operations (quote_id)"))
