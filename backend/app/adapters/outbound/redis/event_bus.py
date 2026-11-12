"""Best-effort live event publisher; durable business changes remain in PostgreSQL."""
from backend.app.adapters.outbound.redis.streams import Streams


class RedisEventBus:
    def __init__(self, streams: Streams | None = None):
        self.streams = streams or Streams()

    async def publish(self, topic: str, event: dict) -> None:
        await self.streams.publish_case_event(topic, event.get("type", "event"), event)
