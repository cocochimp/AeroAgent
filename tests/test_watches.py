import asyncio

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.inbound.http.auth import Principal
from app.adapters.outbound.persistence.models import (
    Base, FlightRecord, PriceAlertRecord, PriceObservationRecord, PriceWatchRecord,
)
from app.adapters.outbound.persistence.seed import seed_demo_data


USER = Principal("u_zhang", frozenset({"user"}))
OTHER_USER = Principal("u_li", frozenset({"user"}))


def _run_with_db(tmp_path, monkeypatch, callback):
    async def run():
        from app.adapters.inbound.http import watches as api
        from app.application import monitoring as service

        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'watches.db'}")
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as session:
            await seed_demo_data(session, force=True)
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.status == "scheduled", FlightRecord.flight_no.like("MU%")))
            selected = (flight.flight_no, flight.date, flight.fares["Y"])
        monkeypatch.setattr(service, "SessionFactory", factory)
        try:
            return await callback(api, service, factory, selected)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _command(selected, **thresholds):
    flight_no, date, _ = selected
    return {"flight_no": flight_no, "date": date, "fare_product": "Y", **thresholds}


async def _set_fare(factory, selected, fare):
    async with factory() as session:
        flight = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == selected[0], FlightRecord.date == selected[1]))
        flight.fares = {**flight.fares, "Y": fare}
        await session.commit()


def test_watch_persists_server_baseline_and_scopes_reads_by_owner(tmp_path, monkeypatch):
    async def check(api, _, factory, selected):
        baseline = selected[2] + 50
        result = await api.create_watch(api.WatchCreateRequest(**_command(
            selected, target_total=baseline - 100, percentage_threshold=10)), USER)

        assert result["user_id"] == USER.user_id
        assert result["baseline_fare"] == selected[2]
        assert result["baseline_tax"] == 50
        assert result["baseline_total"] == baseline
        assert result["target_total"] == baseline - 100
        assert result["percentage_threshold"] == 10
        assert result["currency"] == "CNY"
        assert result["active"] is True
        assert result["last_evaluated_at"] is None
        async with factory() as session:
            stored = await session.get(PriceWatchRecord, result["watch_id"])
            assert stored.baseline_total == baseline
            assert stored.user_id == USER.user_id

        own = await api.list_watches(USER)
        other = await api.list_watches(OTHER_USER)
        assert own["total"] == 1 and other["total"] == 0
        with pytest.raises(HTTPException) as denied:
            await api.get_watch(result["watch_id"], OTHER_USER)
        assert denied.value.status_code == 404

    _run_with_db(tmp_path, monkeypatch, check)


def test_manual_evaluation_records_observation_and_dedupes_alert_history(tmp_path, monkeypatch):
    async def check(api, _, factory, selected):
        baseline = selected[2] + 50
        created = await api.create_watch(api.WatchCreateRequest(**_command(
            selected, target_total=baseline - 50, percentage_threshold=10)), USER)
        await _set_fare(factory, selected, selected[2] - 200)

        first = await api.evaluate_watch(created["watch_id"], USER)
        replay = await api.evaluate_watch(created["watch_id"], USER)
        detail = await api.get_watch(created["watch_id"], USER)
        history = await api.list_alerts(USER)
        other_history = await api.list_alerts(OTHER_USER)

        assert first["observation"]["source"] == "manual"
        assert first["observation"]["status"] == "OBSERVED"
        assert first["observation"]["total"] == baseline - 200
        assert first["alert"]["trigger"] == "TARGET_AND_PERCENTAGE"
        assert first["alert"]["baseline_total"] == baseline
        assert first["alert"]["observed_total"] == baseline - 200
        assert first["alert"]["drop_amount"] == 200
        assert first["alert"]["delivery"] == "dsh_history"
        assert replay["alert"] is None
        assert replay["deduplicated_alert_id"] == first["alert"]["alert_id"]
        assert len(detail["observations"]) == 2
        assert len(detail["alerts"]) == 1
        assert history["total"] == 1
        assert history["alerts"][0]["watch_id"] == created["watch_id"]
        assert other_history["alerts"] == []
        async with factory() as session:
            assert await session.scalar(select(func.count()).select_from(PriceObservationRecord)) == 2
            assert await session.scalar(select(func.count()).select_from(PriceAlertRecord)) == 1

    _run_with_db(tmp_path, monkeypatch, check)


def test_percentage_only_threshold_and_unavailable_observation(tmp_path, monkeypatch):
    async def check(api, _, factory, selected):
        created = await api.create_watch(api.WatchCreateRequest(**_command(
            selected, percentage_threshold=10)), USER)
        await _set_fare(factory, selected, int(selected[2] * 0.8))
        evaluated = await api.evaluate_watch(created["watch_id"], USER)
        assert evaluated["alert"]["trigger"] == "PERCENTAGE"

        async with factory() as session:
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.flight_no == selected[0], FlightRecord.date == selected[1]))
            flight.status = "cancelled"
            await session.commit()
        unavailable = await api.evaluate_watch(created["watch_id"], USER)
        assert unavailable["observation"]["status"] == "UNAVAILABLE"
        assert unavailable["observation"]["total"] is None
        assert unavailable["alert"] is None

    _run_with_db(tmp_path, monkeypatch, check)


def test_backend_evaluation_marks_scheduled_observations(tmp_path, monkeypatch):
    async def check(_, service, factory, selected):
        from app.adapters.inbound.http import watches as api

        created = await api.create_watch(api.WatchCreateRequest(**_command(
            selected, target_total=selected[2])), USER)
        result = await service.evaluate_all_watches()

        assert result == {"evaluated": 1, "alerts": 0, "failed": 0}
        async with factory() as session:
            observation = await session.scalar(select(PriceObservationRecord))
            watch = await session.get(PriceWatchRecord, created["watch_id"])
            assert observation.source == "scheduled"
            assert watch.last_evaluated_at is not None

    _run_with_db(tmp_path, monkeypatch, check)


def test_worker_runs_watch_evaluation_while_backend_is_running(monkeypatch):
    from app import worker

    evaluations = []

    async def evaluate():
        evaluations.append(True)
        return {"evaluated": 0, "alerts": 0}

    async def dispatch(_):
        return None

    class FakeStreams:
        async def read_tasks(self, **_):
            raise asyncio.CancelledError

        async def close(self):
            return None

    monkeypatch.setattr(worker, "Streams", FakeStreams)
    monkeypatch.setattr(worker, "_dispatch_outbox", dispatch)
    monkeypatch.setattr(worker, "evaluate_all_watches", evaluate)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(worker.run_worker())
    assert evaluations == [True]


def test_watch_routes_require_authentication():
    from fastapi.testclient import TestClient
    from app.api.main import app

    client = TestClient(app)
    assert client.get("/api/v1/watches").status_code == 401
    assert client.get("/api/v1/watches/alerts").status_code == 401
    assert client.post("/api/v1/watches", json={}).status_code == 401


def test_concurrent_alert_dedupe_keeps_observation_and_commit(tmp_path, monkeypatch):
    """并发去重要在保存点内失败：观测与评估时间必须落库，请求不能变成 500。"""
    async def check(_, service, factory, selected):
        await service.create_watch(USER.user_id, **_command(selected, target_total=selected[2] + 50))
        watches = await service.list_watches(USER.user_id)
        watch_id = watches["watches"][0]["watch_id"]
        first = await service.evaluate_watch(watch_id, source="scheduled")
        assert first["alert"] is not None

        class RacingSession(AsyncSession):
            async def get(self, entity, ident, **kwargs):
                if entity is PriceAlertRecord:
                    return None            # 模拟并发评估尚未看到对方刚写入的提醒
                return await super().get(entity, ident, **kwargs)

        racing = async_sessionmaker(factory.kw["bind"], expire_on_commit=False, class_=RacingSession)
        monkeypatch.setattr(service, "SessionFactory", racing)
        second = await service.evaluate_watch(watch_id, source="scheduled")

        assert second["alert"] is None
        assert second["deduplicated_alert_id"] == first["alert"]["alert_id"]
        async with factory() as session:
            observations = await session.scalar(select(func.count()).select_from(PriceObservationRecord))
            alerts = await session.scalar(select(func.count()).select_from(PriceAlertRecord))
            watch = await session.get(PriceWatchRecord, watch_id)
        assert observations == 2, "重复提醒不能丢观测"
        assert alerts == 1 and watch.last_evaluated_at is not None

    _run_with_db(tmp_path, monkeypatch, check)


def test_one_failing_watch_does_not_stop_the_others(tmp_path, monkeypatch):
    async def check(_, service, factory, selected):
        await service.create_watch(USER.user_id, **_command(selected, target_total=selected[2] + 50))
        await service.create_watch(USER.user_id, **_command(selected, target_total=selected[2] + 60))
        watches = (await service.list_watches(USER.user_id))["watches"]
        failing, healthy = watches[0]["watch_id"], watches[1]["watch_id"]
        calls = []

        async def fake(watch_id, source="scheduled"):
            calls.append(watch_id)
            if watch_id == failing:
                raise RuntimeError("boom")
            return {"alert": {"alert_id": "alert_ok"}, "observation": {}, "watch": {}}

        monkeypatch.setattr(service, "evaluate_watch", fake)
        result = await service.evaluate_all_watches()

        assert sorted(calls) == sorted([failing, healthy]), "单条失败后必须继续评估其余监控"
        assert result == {"evaluated": 1, "alerts": 1, "failed": 1}

    _run_with_db(tmp_path, monkeypatch, check)
