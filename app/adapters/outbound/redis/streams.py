"""用于任务队列和可续传案件事件的进程内流。"""
import asyncio
import json
import time
from collections import defaultdict, deque
from typing import Any


TASK_STREAM = "air-ticket:tasks"
DEAD_STREAM = "air-ticket:tasks:dead"


def _cursor(value: str) -> tuple[int, int]:
    try:
        milliseconds, sequence = value.split("-", 1)
        return int(milliseconds), int(sequence)
    except (AttributeError, ValueError):
        return 0, 0


class _Broker:
    def __init__(self):
        self.events = defaultdict(list)
        self.tasks = deque()
        self.counters = {}
        self.condition = asyncio.Condition()

    def next_id(self, key: str) -> str:
        """生成毫秒加序列的单调流标识；同毫秒事件通过序列保持先后顺序。"""
        now = time.time_ns() // 1_000_000
        last_ms, sequence = self.counters.get(key, (0, -1))
        if now > last_ms:
            last_ms, sequence = now, 0
        else:
            sequence += 1
        self.counters[key] = (last_ms, sequence)
        return f"{last_ms}-{sequence}"


_broker = _Broker()


class Streams:
    """单进程替代实现，保留 HTTP 与 worker 使用的 Stream 数据结构。"""

    def __init__(self, client=None):
        if client is not None:
            raise ValueError("lite 模式不支持外部 Streams 客户端")
        self.client = self
        self._closed = False

    async def _append(self, key: str, values: dict[str, str], *, maxlen: int) -> str:
        async with _broker.condition:
            stream_id = _broker.next_id(key)
            events = _broker.events[key]
            events.append((stream_id, values))
            if len(events) > maxlen:
                del events[:-maxlen]
            _broker.condition.notify_all()
            return stream_id

    async def enqueue(self, kind: str, payload: dict[str, Any], *, attempts: int = 0,
                      error: str = "", dead: bool = False) -> str:
        """追加任务或死信消息；只有活任务进入待消费队列并唤醒 worker。"""
        key = DEAD_STREAM if dead else TASK_STREAM
        values = {"kind": kind, "payload": json.dumps(payload, ensure_ascii=False)}
        if attempts:
            values["attempts"] = str(attempts)
        if error:
            values["error"] = error
        stream_id = await self._append(key, values, maxlen=10000)
        if not dead:
            async with _broker.condition:
                _broker.tasks.append((stream_id, values))
                _broker.condition.notify_all()
        return stream_id

    async def read_tasks(self, *, count: int = 5, block_ms: int = 1000):
        """阻塞等待并批量取出任务；取出即离队的轻量语义由 worker 重投兜底。"""
        def available():
            """同步判断任务队列是否已有消息；条件变量的 predicate 不能是协程。"""
            return bool(_broker.tasks)

        async with _broker.condition:
            if not _broker.tasks and block_ms > 0:
                try:
                    await asyncio.wait_for(_broker.condition.wait_for(available), timeout=block_ms / 1000)
                except TimeoutError:
                    pass
            messages = []
            while _broker.tasks and len(messages) < count:
                messages.append(_broker.tasks.popleft())
            return [(TASK_STREAM, messages)] if messages else []

    async def publish_case_event(self, case_id: str, event_type: str, payload: dict[str, Any]) -> str:
        """发布有界案件事件流；返回流标识供 SSE 断点续传。"""
        return await self._append(self.case_stream(case_id), {
            "event": event_type,
            "payload": json.dumps(payload, ensure_ascii=False),
        }, maxlen=2000)

    async def read_case_events(self, case_id: str, last_id: str = "0-0", *, block_ms: int = 1000):
        """读取指定游标之后的案件事件；没有新事件时按超时短暂阻塞。"""
        key = self.case_stream(case_id)

        def available():
            """判断游标后是否已有事件；避免无数据时持续唤醒。"""
            return any(_cursor(stream_id) > _cursor(last_id) for stream_id, _ in _broker.events[key])

        async with _broker.condition:
            if not available() and block_ms > 0:
                try:
                    await asyncio.wait_for(_broker.condition.wait_for(available), timeout=block_ms / 1000)
                except TimeoutError:
                    pass
            messages = [(stream_id, values) for stream_id, values in _broker.events[key]
                        if _cursor(stream_id) > _cursor(last_id)][:100]
            return [(key, messages)] if messages else []

    async def ping(self) -> bool:
        """检查流客户端是否尚未关闭；供健康检查复用统一接口。"""
        return not self._closed

    async def close(self) -> None:
        """标记客户端关闭；进程内实现没有外部连接需要释放。"""
        self._closed = True

    @staticmethod
    def case_stream(case_id: str) -> str:
        """生成案件事件流键；读写两端共享同一命名规则。"""
        return f"air-ticket:case:{case_id}:events"
