"""Async PostgreSQL engine and request-scoped session dependency."""
import os
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .models import Base


DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql+asyncpg://air:air@127.0.0.1:5432/air_ticket"
)
engine = create_async_engine(DATABASE_URL, pool_pre_ping=True, pool_size=5, max_overflow=10)
SessionFactory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionFactory() as session:
        yield session


async def initialize_schema() -> None:
    """Create local/demo tables. Production should use checked-in migrations."""
    if os.getenv("AUTO_CREATE_SCHEMA", "false").lower() != "true":
        return
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
