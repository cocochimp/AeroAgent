"""票务领域拥有的订单仓储端口。"""
from typing import Protocol


class OrderRepository(Protocol):
    """定义订单只读端口；票务领域不依赖具体持久化技术。"""

    async def get_order(self, order_id: str) -> dict | None:
        """按订单号读取订单；不存在时返回空值。"""
        ...

    async def list_orders(self, user_id: str) -> list[dict]:
        """列出用户订单；排序策略由适配器决定。"""
        ...
