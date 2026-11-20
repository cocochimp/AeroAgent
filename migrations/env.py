import asyncio
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.adapters.outbound.persistence.models import Base

config = context.config
config.set_main_option("sqlalchemy.url", os.getenv(
    "DATABASE_URL", config.get_main_option("sqlalchemy.url")).replace("%", "%%"))
if config.config_file_name:
    fileConfig(config.config_file_name)
target_metadata = Base.metadata


def run_migrations_offline():
    """在离线模式生成并执行迁移；不创建数据库连接且保留类型比较。"""
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata,
                      literal_binds=True, dialect_opts={"paramstyle": "named"}, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection):
    """在既有连接上配置并执行迁移；由在线模式的同步桥接调用。"""
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online():
    """创建异步连接执行迁移；结束后释放引擎，避免进程退出残留连接。"""
    connectable = async_engine_from_config(config.get_section(config.config_ini_section, {}),
                                           prefix="sqlalchemy.", poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
