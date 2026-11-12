"""Policy lookup port. Retrieval ranks evidence; domain policy decides eligibility."""
from typing import Protocol


class PolicyRepository(Protocol):
    async def get_rule(self, rule_id: str) -> dict | None: ...
    async def list_rules(self, *, airline: str | None = None, cabin: str | None = None,
                         fare_product: str | None = None, scenario: str | None = None) -> list[dict]: ...
