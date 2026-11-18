import importlib

from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, inspect, text
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
