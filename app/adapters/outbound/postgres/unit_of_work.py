"""覆盖操作、账本和 Outbox 写入的事务边界。"""
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .repositories import (
    PostgresCaseRepository,
    PostgresOperationRepository,
    PostgresOutboxRepository,
    PostgresOrderRepository,
    PostgresPolicyRepository,
    PostgresQuoteRepository,
)


class PostgresUnitOfWork:
    """用同一异步会话组装全部仓储；操作、账本和 Outbox 可共享一个事务。"""
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]):
        self._session_factory = session_factory
        self.session: AsyncSession | None = None

    async def __aenter__(self):
        """创建会话并初始化仓储；所有仓储共享同一事务连接。"""
        self.session = self._session_factory()
        self.cases = PostgresCaseRepository(self.session)
        self.quotes = PostgresQuoteRepository(self.session)
        self.operations = PostgresOperationRepository(self.session)
        self.outbox = PostgresOutboxRepository(self.session)
        self.orders = PostgresOrderRepository(self.session)
        self.policies = PostgresPolicyRepository(self.session)
        return self

    async def __aexit__(self, exc_type, exc, tb):
        """按是否有异常提交或回滚；无论结果如何最后关闭会话。"""
        assert self.session is not None
        try:
            if exc_type is None:
                await self.session.commit()
            else:
                await self.session.rollback()
        finally:
            await self.session.close()
        return False

    async def commit(self) -> None:
        """显式提交当前事务；供用例在上下文自动提交前固定业务状态。"""
        assert self.session is not None
        await self.session.commit()
