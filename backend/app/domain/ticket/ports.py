"""Ticket-owned repository port."""
from typing import Protocol


class OrderRepository(Protocol):
    async def get_order(self, order_id: str) -> dict | None: ...
    async def list_orders(self, user_id: str) -> list[dict]: ...
