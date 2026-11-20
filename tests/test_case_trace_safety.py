import pytest

from app.application.cases.service import sanitize_trace_event


def test_trace_event_unwraps_agent_event_and_redacts_business_text_and_secrets():
    event = sanitize_trace_event({"type": "trace", "event": {
        "node": "tool_rule_retrieve", "status": "ok", "ms": 4, "at": "2026-11-12T10:00:00+08:00",
        "note": "检索退改规则", "input": {"question": "帮我退票，护照号123", "order_id": "ORD1"},
        "output": {"rule_ids": ["MU-Y-RFD"], "api_key": "sk-secret", "score": 0.93,
                   "content": "raw rule document", "count": 3},
    }})
    assert event == {
        "node": "tool_rule_retrieve", "status": "ok", "ms": 4,
        "at": "2026-11-12T10:00:00+08:00", "note": "检索退改规则",
        "input": {"order_id": "ORD1"},
        "output": {"rule_ids": ["MU-Y-RFD"], "score": 0.93, "count": 3},
    }


def test_cancel_request_requires_unambiguous_explicit_phrase():
    from app.adapters.inbound.http.cases import is_cancel_request
    assert is_cancel_request("取消")
    assert is_cancel_request("暂不办理")
    assert not is_cancel_request("我想咨询改签后能否取消")


def test_agent_trace_callback_persists_safe_case_trace_event(monkeypatch):
    import asyncio
    import app.application.cases.service as service
    recorded = []
    async def record(case_id, event_type, payload):
        recorded.append((case_id, event_type, payload))
    monkeypatch.setattr(service, "record_case_event", record)

    async def run():
        callback = service.make_agent_event_callback("case-1", asyncio.get_running_loop())
        await asyncio.to_thread(callback, {"type": "trace", "event": {
            "node": "user_input", "status": "ok", "ms": 1, "input": {"question": "private", "order_id": "O1"}}})
    asyncio.run(run())
    assert recorded == [("case-1", "case.trace", {"node": "user_input", "status": "ok", "ms": 1,
                                                         "input": {"order_id": "O1"}})]


def test_case_cancellation_cancels_every_offered_quote(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    import app.adapters.inbound.http.cases as api
    from app.adapters.inbound.http.auth import Principal
    case = SimpleNamespace(case_id="case-1", user_id="u1", session_id="s1", order_id="O1", current_quote_id="q1")
    first = SimpleNamespace(quote_id="q1", status="OFFERED")
    second = SimpleNamespace(quote_id="q2", status="OFFERED")
    current_case = SimpleNamespace(status="WAITING_CONFIRMATION", updated_at=None)
    class Result:
        rowcount = 1
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key, **kwargs):
            if model.__name__ == "QuoteRecord": return first if key == "q1" else second
            return current_case
        async def execute(self, _statement):
            first.status = second.status = "CANCELLED"
            current_case.status = "CANCELLED"
            return Result()
        async def scalars(self, _): return [first, second]
        async def commit(self): pass
    events = []
    monkeypatch.setattr(api, "_owned_case", lambda *_: asyncio.sleep(0, result=case))
    monkeypatch.setattr(api.legacy_graph, "pending_interrupt", lambda *_: {"kind": "confirm"})
    monkeypatch.setattr(api, "SessionFactory", Session)
    async def record(*args): events.append(args)
    monkeypatch.setattr(api, "record_case_event", record)

    async def call():
        return await api.add_case_message("case-1", api.CaseMessageRequest(message="取消"),
                                          Principal("u1", frozenset({"user"})))
    result = asyncio.run(call())
    assert result["status"] == "CANCELLED"
    assert result["quote_ids"] == ["q1", "q2"]
    assert first.status == second.status == current_case.status == "CANCELLED"
    assert events[0][1:] == ("case.cancelled", {"quote_id": "q1", "quote_ids": ["q1", "q2"]})


def test_event_reconnect_delivers_after_cursor_once(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    import app.adapters.inbound.http.cases as api
    from app.adapters.inbound.http.auth import Principal
    from app.adapters.outbound.persistence.models import CaseEventRecord
    case = SimpleNamespace(case_id="case-1", user_id="u1", status="COMPLETED")
    rows = [SimpleNamespace(id=2, case_id="case-1", event_type="case.trace", stream_id="2-0",
                            payload={"node": "a"}),
            SimpleNamespace(id=3, case_id="case-1", event_type="case.trace", stream_id="3-0",
                            payload={"node": "b"})]
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def scalars(self, statement): return rows
        async def get(self, model, key): return case
    monkeypatch.setattr(api, "_owned_case", lambda *_: asyncio.sleep(0, result=case))
    monkeypatch.setattr(api, "SessionFactory", Session)
    class Request:
        calls = 0
        async def is_disconnected(self):
            self.calls += 1
            return self.calls > 3
    class Streams:
        calls = 0
        async def read_case_events(self, case_id, cursor, block_ms=0):
            self.calls += 1
            if self.calls == 1:
                assert cursor == "1-0"
                return [("stream", [("2-0", {"event": "case.trace", "payload": '{"node": "a"}'})])]
            return []
        async def close(self): pass
    monkeypatch.setattr(api, "Streams", Streams)

    async def call():
        response = await api.stream_case_events("case-1", Request(), Principal("u1", frozenset({"user"})),
                                                after="1-0")
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
        return "".join(chunks)
    result = asyncio.run(call())
    assert result.count('"node": "a"') == 1
    assert result.count('"node": "b"') == 1


def test_failed_agent_turn_records_explainable_event_and_terminal_status(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    import app.application.cases.service as service
    case = SimpleNamespace(status="OPEN", updated_at=None, result={})
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key): return case
        async def commit(self): pass
    monkeypatch.setattr(service, "SessionFactory", Session)
    monkeypatch.setattr(service, "sync_agent_projection", lambda *_: asyncio.sleep(0))
    events = []
    async def record(*args): events.append(args)
    monkeypatch.setattr(service, "record_case_event", record)
    class Agent:
        def run_turn(self, *args, **kwargs): raise RuntimeError("private details do not leak")
    monkeypatch.setattr(service, "_main_agent", Agent())

    async def call():
        try:
            await service.run_case_turn({"case_id": "case-1", "user_id": "u1", "session_id": "s1", "message": "退票"})
        except RuntimeError:
            return
        raise AssertionError("failure should remain visible to the worker")
    asyncio.run(call())
    assert case.status == "RESULT_UNKNOWN"
    assert case.result["error"]["message"] == "本轮处理未完成，已保留此前运行事件。"
    assert events[-1][1] == "case.failed"
    assert "private details" not in str(events[-1][2])


def test_replayed_confirmation_is_idempotent_and_emits_trace_event(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    import app.application.cases.service as service
    from app.adapters.outbound.persistence.models import QuoteRecord
    quote = SimpleNamespace(quote_id="q1", case_id="case-1", status="CONFIRMED", confirmation_id="confirm-1", amount=300)
    case = SimpleNamespace(case_id="case-1", user_id="u1")
    operation = SimpleNamespace(status="PENDING", operation_id="op-1")
    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key, **kwargs): return quote if model is QuoteRecord else case
        async def scalar(self, statement): return operation
    events = []
    async def record(*args): events.append(args)
    monkeypatch.setattr(service, "SessionFactory", Session)
    monkeypatch.setattr(service, "record_case_event", record)

    async def call():
        return await service.create_confirmed_operation("q1", "u1", "confirm-1", "idempotency-1")
    result = asyncio.run(call())
    assert result == {"status": "PENDING", "operation_id": "op-1", "quote_id": "q1",
                      "amount": 300, "idempotent": True}
    assert events == [("case-1", "quote.confirmation_replayed", {"quote_id": "q1", "confirmation_id": "confirm-1"})]


def test_replayed_confirmed_quote_without_operation_raises_explicit_error(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    import app.application.cases.service as service
    from app.adapters.outbound.persistence.models import QuoteRecord
    quote = SimpleNamespace(quote_id="q1", case_id="case-1", status="CONFIRMED",
                            confirmation_id="confirm-1", amount=300)
    case = SimpleNamespace(case_id="case-1", user_id="u1")
    events = []

    class Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *args): return None
        async def get(self, model, key, **kwargs): return quote if model is QuoteRecord else case
        async def scalar(self, statement): return None

    async def record(*args): events.append(args)
    monkeypatch.setattr(service, "SessionFactory", Session)
    monkeypatch.setattr(service, "record_case_event", record)

    async def call():
        await service.create_confirmed_operation("q1", "u1", "confirm-1", "idempotency-1")

    with pytest.raises(LookupError, match="已确认报价缺少办理记录"):
        asyncio.run(call())
