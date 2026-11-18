import asyncio
import importlib

from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine
from alembic.migration import MigrationContext
from alembic.operations import Operations


def test_order_booking_and_watch_migration_upgrades_existing_orders(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'migration.db'}")
    metadata = MetaData()
    Table("profiles", metadata, Column("user_id", String(64), primary_key=True))
    Table("flights", metadata,
          Column("id", Integer, primary_key=True),
          Column("origin", String(8), nullable=False),
          Column("dest", String(8), nullable=False),
          Column("date", String(10), nullable=False))
    orders = Table(
        "orders", metadata,
        Column("order_id", String(64), primary_key=True),
        Column("user_id", String(64), nullable=False),
        Column("passenger", String(160), nullable=False),
        Column("flight_no", String(16), nullable=False),
        Column("date", String(10), nullable=False),
        Column("airline", String(4), nullable=False),
        Column("cabin", String(8), nullable=False),
        Column("fare_product", String(40), nullable=False),
        Column("fare", Integer, nullable=False),
        Column("tax", Integer, nullable=False),
        Column("status", String(24), nullable=False),
        Column("ticket_no", String(40), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(orders.insert().values(
            order_id="ORD-EXISTING", user_id="u1", passenger="Existing", flight_no="MU5101",
            date="2026-09-28", airline="MU", cabin="Y", fare_product="Y", fare=500,
            tax=50, status="ISSUED", ticket_no="781-1"))

    migration = importlib.import_module("migrations.versions.0003_order_booking_watches")
    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            migration.upgrade()

    inspector = inspect(engine)
    columns = {column["name"]: column for column in inspector.get_columns("orders")}
    assert {"created_at", "updated_at", "currency", "paid_at"} <= columns.keys()
    assert {"booking_attempts", "price_watches", "price_observations", "price_alerts"} <= set(
        inspector.get_table_names())
    with engine.connect() as connection:
        row = connection.execute(text(
            "SELECT created_at, updated_at, currency, paid_at FROM orders WHERE order_id='ORD-EXISTING'"
        )).mappings().one()
        assert row["created_at"] is not None
        assert row["updated_at"] is not None
        assert row["currency"] == "CNY"
        assert row["paid_at"] is None
    engine.dispose()


def test_initialize_schema_upgrades_legacy_order_columns(tmp_path, monkeypatch):
    from app.adapters.outbound.postgres import database

    async def run():
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy-runtime.db'}")
        async with engine.begin() as connection:
            await connection.execute(text("PRAGMA foreign_keys=ON"))
            await connection.execute(text("""
                CREATE TABLE service_cases (
                    case_id VARCHAR(64) PRIMARY KEY,
                    order_id VARCHAR(64) REFERENCES orders(order_id)
                )
            """))
            await connection.execute(text("""
                CREATE TABLE orders (
                    order_id VARCHAR(64) PRIMARY KEY,
                    user_id VARCHAR(64) NOT NULL,
                    passenger VARCHAR(160) NOT NULL,
                    flight_no VARCHAR(16) NOT NULL,
                    date VARCHAR(10) NOT NULL,
                    airline VARCHAR(4) NOT NULL,
                    cabin VARCHAR(8) NOT NULL,
                    fare_product VARCHAR(40) NOT NULL,
                    fare INTEGER NOT NULL,
                    tax INTEGER NOT NULL,
                    status VARCHAR(24) NOT NULL,
                    ticket_no VARCHAR(40) NOT NULL
                )
            """))
            await connection.execute(text("""
                INSERT INTO orders VALUES ('ORD-OLD', 'u1', 'Existing', 'MU5101', '2026-09-28',
                    'MU', 'Y', 'Y', 500, 50, 'ISSUED', '781-1')
            """))
        monkeypatch.setattr(database, "get_engine", lambda: engine)
        await database.initialize_schema()
        async with engine.connect() as connection:
            columns = await connection.run_sync(
                lambda sync: {column["name"] for column in inspect(sync).get_columns("orders")})
        assert {"created_at", "updated_at", "currency", "paid_at"} <= columns
        await engine.dispose()

    asyncio.run(run())


def test_new_order_schema_uses_runtime_timestamp_defaults(tmp_path):
    from app.adapters.outbound.postgres.models import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'new-defaults.db'}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text(
            "INSERT INTO profiles (user_id, name, tier, data) VALUES ('u1', 'User', '普通', '{}')"))
        connection.execute(text("""
            INSERT INTO orders (order_id, user_id, passenger, flight_no, date, airline, cabin,
                                fare_product, fare, tax, status, ticket_no)
            VALUES ('ORD-RAW', 'u1', 'User', 'MU5101', '2026-09-28', 'MU', 'Y', 'Y',
                    500, 50, 'ISSUED', '781-1')
        """))
    with engine.connect() as connection:
        row = connection.execute(text(
            "SELECT created_at, updated_at, currency FROM orders WHERE order_id='ORD-RAW'"
        )).mappings().one()
        assert row["created_at"] != "CURRENT_TIMESTAMP"
        assert row["updated_at"] != "CURRENT_TIMESTAMP"
        assert row["currency"] == "CNY"
    engine.dispose()


def test_full_migration_chain_handles_current_initial_metadata(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'fresh-chain.db'}")
    migrations = [importlib.import_module(f"migrations.versions.{name}") for name in (
        "0001_initial", "0002_airline_receipts", "0003_order_booking_watches")]

    with engine.begin() as connection:
        context = MigrationContext.configure(connection)
        with Operations.context(context):
            for migration in migrations:
                migration.upgrade()

    inspector = inspect(engine)
    assert {"orders", "booking_attempts", "price_watches", "price_observations", "price_alerts"} <= set(
        inspector.get_table_names())
    assert {"created_at", "updated_at", "currency", "paid_at"} <= {
        column["name"] for column in inspector.get_columns("orders")}
    engine.dispose()


def _legacy_db_with_case_fk(path):
    """旧库形状：orders 被 service_cases.order_id 外键引用，且缺少新列。"""
    engine = create_engine(f"sqlite:///{path}")
    metadata = MetaData()
    Table("flights", metadata,
          Column("id", Integer, primary_key=True),
          Column("origin", String(8), nullable=False),
          Column("dest", String(8), nullable=False),
          Column("date", String(10), nullable=False))
    orders = Table(
        "orders", metadata,
        Column("order_id", String(64), primary_key=True),
        Column("user_id", String(64), nullable=False),
        Column("passenger", String(160), nullable=False),
        Column("flight_no", String(16), nullable=False),
        Column("date", String(10), nullable=False),
        Column("airline", String(4), nullable=False),
        Column("cabin", String(8), nullable=False),
        Column("fare_product", String(40), nullable=False),
        Column("fare", Integer, nullable=False),
        Column("tax", Integer, nullable=False),
        Column("status", String(24), nullable=False),
        Column("ticket_no", String(40), nullable=False),
    )
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=ON"))
        connection.execute(text("""
            CREATE TABLE service_cases (
                case_id VARCHAR(64) PRIMARY KEY,
                order_id VARCHAR(64) REFERENCES orders(order_id)
            )
        """))
        connection.execute(orders.insert().values(
            order_id="ORD-LEGACY", user_id="u1", passenger="Legacy", flight_no="MU5101",
            date="2026-09-28", airline="MU", cabin="Y", fare_product="Y", fare=500,
            tax=50, status="ISSUED", ticket_no="781-1"))
    return engine


def test_migration_survives_case_foreign_key_and_is_retry_safe(tmp_path):
    migration = importlib.import_module("migrations.versions.0003_order_booking_watches")

    engine = _legacy_db_with_case_fk(tmp_path / "legacy-fk.db")
    try:
        for _ in range(2):                      # 第二次等价于失败后的重跑
            with engine.begin() as connection:
                context = MigrationContext.configure(connection)
                with Operations.context(context):
                    migration.upgrade()
        with engine.connect() as connection:
            row = connection.execute(text(
                "SELECT created_at, updated_at, currency FROM orders WHERE order_id='ORD-LEGACY'"
            )).mappings().one()
        assert row["created_at"] is not None and row["updated_at"] is not None
        assert row["currency"] == "CNY"
    finally:
        engine.dispose()
