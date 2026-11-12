"""Transaction boundary spanning operation, ledger, and outbox writes."""
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
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]):
        self._session_factory = session_factory
        self.session: AsyncSession | None = None

    async def __aenter__(self):
        self.session = self._session_factory()
        self.cases = PostgresCaseRepository(self.session)
        self.quotes = PostgresQuoteRepository(self.session)
        self.operations = PostgresOperationRepository(self.session)
        self.outbox = PostgresOutboxRepository(self.session)
        self.orders = PostgresOrderRepository(self.session)
        self.policies = PostgresPolicyRepository(self.session)
        return self

    async def __aexit__(self, exc_type, exc, tb):
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
        assert self.session is not None
        await self.session.commit()
