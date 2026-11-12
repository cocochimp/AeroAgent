"""Temporary bridge that keeps the existing validated fare engine in service."""
from air_agent import data, engine, retrieval, seed


class LegacyTicketService:
    """Wrap legacy functions behind the new application-facing boundary."""

    def get_order(self, order_id: str) -> dict | None:
        return data.get_order(order_id)

    def list_orders(self, user_id: str) -> list[dict]:
        return data.list_orders(user_id)

    def calculate(self, order_id: str, action: str, target_date: str | None = None,
                  target_flight: str | None = None) -> dict:
        return engine.calc(order_id, action, target_date, target_flight)

    def search_rules(self, query: str, filters: dict | None = None, boost: dict | None = None) -> dict:
        return retrieval.search(query, filters or {}, boost or {})

    def reset_demo_data(self) -> None:
        data.init(force=True)
