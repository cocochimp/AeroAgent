"""Refresh the legacy Agent read projection after a PostgreSQL policy edit."""
from backend.app.adapters.outbound.legacy.runtime_projection import sync_agent_projection
from backend.app.adapters.outbound.postgres.database import SessionFactory


async def sync_rules_to_legacy_index() -> None:
    async with SessionFactory() as session:
        await sync_agent_projection(session)
