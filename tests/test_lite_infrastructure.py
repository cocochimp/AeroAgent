import asyncio
import json
import warnings
from datetime import datetime, timezone

from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.adapters.outbound.persistence.models import Base, EvaluationCaseSetRecord, OrderRecord, ProfileRecord
from app.adapters.outbound.persistence.seed import seed_demo_data
from app.adapters.outbound.messaging import streams as streams_module
from app.adapters.outbound.messaging.streams import Streams


def test_memory_streams_replay_after_cursor_and_close_is_instance_local():
    async def run():
        publisher = Streams()
        reader = Streams()
        case_id = "case-lite-replay"
        first = await publisher.publish_case_event(case_id, "case.started", {"n": 1})
        second = await publisher.publish_case_event(case_id, "case.proposed", {"n": 2})

        records = await reader.read_case_events(case_id, first, block_ms=0)
        assert [(stream_id, values["event"], json.loads(values["payload"]))
                for _, messages in records for stream_id, values in messages] == [
            (second, "case.proposed", {"n": 2})
        ]

        await reader.close()
        reopened = Streams()
        replayed = await reopened.read_case_events(case_id, "0-0", block_ms=0)
        assert [stream_id for _, messages in replayed for stream_id, _ in messages] == [first, second]
        await publisher.close()
        await reopened.close()

    asyncio.run(run())


def test_memory_streams_block_until_another_instance_publishes():
    async def run():
        reader = Streams()
        publisher = Streams()
        case_id = "case-lite-block"
        pending = asyncio.create_task(reader.read_case_events(case_id, "0-0", block_ms=5000))
        await asyncio.sleep(0.03)
        assert not pending.done()
        stream_id = await publisher.publish_case_event(case_id, "case.trace", {"node": "retrieve"})
        records = await asyncio.wait_for(pending, timeout=1)
        assert [(item_id, json.loads(values["payload"]))
                for _, messages in records for item_id, values in messages] == [
            (stream_id, {"node": "retrieve"})
        ]
        await reader.close()
        await publisher.close()

    asyncio.run(run())


def test_sqlite_persists_dict_and_list_json_columns():
    async def run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        now = datetime.now(timezone.utc)
        async with factory() as session:
            session.add(ProfileRecord(user_id="u-lite", name="Lite", tier="普通", data={"routes": {"HGH-PEK": 2}}))
            session.add(EvaluationCaseSetRecord(version="v-lite", cases=[{"id": "refund", "expect": {"status": "CHANGED"}}],
                                                created_at=now, created_by="test"))
            await session.commit()
        async with factory() as session:
            profile = await session.get(ProfileRecord, "u-lite", with_for_update=True)
            case_set = await session.get(EvaluationCaseSetRecord, "v-lite")
            assert profile.data == {"routes": {"HGH-PEK": 2}}
            assert case_set.cases == [{"id": "refund", "expect": {"status": "CHANGED"}}]
        await engine.dispose()

    asyncio.run(run())


def test_sqlite_seed_inserts_profiles_before_orders_with_foreign_keys():
    async def run():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")

        @event.listens_for(engine.sync_engine, "connect")
        def enable_foreign_keys(dbapi_connection, _):
            dbapi_connection.execute("PRAGMA foreign_keys=ON")

        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
        async with factory() as session:
            await seed_demo_data(session)
            assert await session.scalar(select(func.count()).select_from(ProfileRecord)) == 4
            assert await session.scalar(select(func.count()).select_from(OrderRecord)) == 13
        await engine.dispose()

    asyncio.run(run())


def test_memory_streams_read_tasks_waits_for_enqueue_without_coroutine_warning():
    async def run():
        # 每个 asyncio.run 都创建新事件循环，避免全局 Condition 被前序用例的循环绑定
        streams_module._broker = streams_module._Broker()
        reader = Streams()
        publisher = Streams()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always", RuntimeWarning)
            pending = asyncio.create_task(reader.read_tasks(block_ms=5000))
            await asyncio.sleep(0.03)
            assert not pending.done(), "空队列应继续等待，而不是把协程 predicate 当真值立即返回"

            stream_id = await publisher.enqueue("case.turn", {"case_id": "case-lite-task"})
            batches = await asyncio.wait_for(pending, timeout=1)
            assert [(item_id, json.loads(values["payload"]))
                    for _, messages in batches for item_id, values in messages] == [
                (stream_id, {"case_id": "case-lite-task"})
            ]
            assert not [item for item in caught if issubclass(item.category, RuntimeWarning)]
        await reader.close()
        await publisher.close()

    asyncio.run(run())
