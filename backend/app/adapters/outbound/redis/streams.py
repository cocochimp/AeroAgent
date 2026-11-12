"""Redis Streams operations for jobs and case event replay."""
import json
import os
from typing import Any

from redis.asyncio import Redis


REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")
TASK_STREAM = "air-ticket:tasks"


def redis_client() -> Redis:
    return Redis.from_url(REDIS_URL, decode_responses=True, socket_timeout=5)


class Streams:
    def __init__(self, client: Redis | None = None):
        self.client = client or redis_client()

    async def enqueue(self, kind: str, payload: dict[str, Any]) -> str:
        return await self.client.xadd(TASK_STREAM, {"kind": kind, "payload": json.dumps(payload, ensure_ascii=False)},
                                      maxlen=10000, approximate=True)

    async def publish_case_event(self, case_id: str, event_type: str, payload: dict[str, Any]) -> str:
        key = self.case_stream(case_id)
        return await self.client.xadd(key, {"event": event_type, "payload": json.dumps(payload, ensure_ascii=False)},
                                      maxlen=2000, approximate=True)

    async def read_case_events(self, case_id: str, last_id: str = "0-0", *, block_ms: int = 1000):
        return await self.client.xread({self.case_stream(case_id): last_id}, count=100, block=block_ms)

    async def close(self) -> None:
        await self.client.aclose()

    @staticmethod
    def case_stream(case_id: str) -> str:
        return f"air-ticket:case:{case_id}:events"
