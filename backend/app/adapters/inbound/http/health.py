"""Readiness probe for required runtime dependencies."""
from fastapi import APIRouter, Response
from sqlalchemy import text

from backend.app.adapters.outbound.postgres.database import SessionFactory
from backend.app.adapters.outbound.redis.streams import Streams

router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health")
async def health(response: Response):
    dependencies = {"postgres": "ok", "redis": "ok"}
    try:
        async with SessionFactory() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        dependencies["postgres"] = "unavailable"
    streams = Streams()
    try:
        await streams.client.ping()
    except Exception:
        dependencies["redis"] = "unavailable"
    finally:
        await streams.close()
    overall = "ok" if dependencies["postgres"] == "ok" and dependencies["redis"] == "ok" else "degraded"
    response.status_code = 200 if overall == "ok" else 503
    return {"status": overall, "dependencies": dependencies}
