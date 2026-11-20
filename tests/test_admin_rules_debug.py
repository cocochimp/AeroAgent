import asyncio
from types import SimpleNamespace

from app.adapters.inbound.http import admin
from app.adapters.inbound.http.auth import Principal
from app.adapters.outbound.persistence.models import RuleRecord


class RuleSession:
    def __init__(self):
        self.rows = [SimpleNamespace(id="MU-RFD", airline="MU", cabin="Y", fare_product="Y",
            scenario="VOLUNTARY_REFUND", title="退票规则", content="符合票规可申请", version=1,
            active=True, updated_at=None)]

    async def __aenter__(self): return self
    async def __aexit__(self, *_): return None
    async def scalars(self, _query): return self.rows


def test_admin_rule_debug_returns_actual_retrieval_funnel(monkeypatch):
    monkeypatch.setattr(admin, "SessionFactory", lambda: RuleSession())
    calls = []
    monkeypatch.setattr(admin.agent_retrieval, "search", lambda query, filters: calls.append((query, filters)) or {
        "query": query, "backend": "fallback", "funnel": [{"stage": "dense", "k": 60, "count": 1,
            "items": [{"id": "MU-RFD", "score": 0.87}]}]})

    result = asyncio.run(admin.list_rules(Principal("admin", frozenset({"admin"})), airline="MU", q="自愿退票", debug=True))

    assert calls == [("自愿退票", {"airline": "MU"})]
    assert result["debug"]["retrieval"]["funnel"][0]["items"][0] == {"id": "MU-RFD", "score": 0.87}
