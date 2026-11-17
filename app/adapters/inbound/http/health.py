"""检查 lite 运行必需依赖的就绪探针。"""
from fastapi import APIRouter, Response
from sqlalchemy import text

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.redis.streams import Streams

router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health")
async def health(response: Response):
    """检查 SQLite 和任务队列可用性；任一依赖失败即返回 503 和降级状态。"""
    dependencies = {"sqlite": "ok", "queue": "ok"}
    try:
        async with SessionFactory() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        dependencies["sqlite"] = "unavailable"
    streams = Streams()
    try:
        if not await streams.ping():
            dependencies["queue"] = "unavailable"
    except Exception:
        dependencies["queue"] = "unavailable"
    finally:
        await streams.close()
    overall = "ok" if all(value == "ok" for value in dependencies.values()) else "degraded"
    response.status_code = 200 if overall == "ok" else 503
    return {"status": overall, "dependencies": dependencies}
