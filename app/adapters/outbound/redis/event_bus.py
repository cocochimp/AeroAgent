"""尽力投递的实时事件发布器；持久业务状态仍以 SQLite 为准。"""
from app.adapters.outbound.redis.streams import Streams


class InProcessEventBus:
    """提供进程内事件发布适配器；业务持久化不依赖该实时通道成功。"""
    def __init__(self, streams: Streams | None = None):
        self.streams = streams or Streams()

    async def publish(self, topic: str, event: dict) -> None:
        """把主题事件写入案件流；事件类型缺省时使用通用标记。"""
        await self.streams.publish_case_event(topic, event.get("type", "event"), event)
