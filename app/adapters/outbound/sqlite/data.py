"""SQLite 数据层：建表、写入种子数据、查询与修改。"""
import json
import sqlite3
import threading
from datetime import datetime
from contextlib import contextmanager
from app.application import seed
from app.demo_data import load_demo_seed
from app import config as S

_init_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS flights(flight_no TEXT, date TEXT, airline TEXT, origin TEXT, dest TEXT,
  origin_city TEXT, dest_city TEXT, dep_time TEXT, duration_min INT, status TEXT, delay_min INT,
  fares TEXT, PRIMARY KEY(flight_no, date));
CREATE TABLE IF NOT EXISTS orders(order_id TEXT PRIMARY KEY, user_id TEXT, passenger TEXT, flight_no TEXT,
  date TEXT, airline TEXT, cabin TEXT, fare_product TEXT, fare INT, tax INT, status TEXT, ticket_no TEXT);
CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY, name TEXT, tier TEXT, data TEXT);
CREATE TABLE IF NOT EXISTS fee_rules(airline TEXT, fare_product TEXT, data TEXT, PRIMARY KEY(airline, fare_product));
CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY, airline TEXT, cabin TEXT, fare_product TEXT,
  scenario TEXT, title TEXT, content TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS session_memory(session_id TEXT PRIMARY KEY, user_id TEXT, data TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS tickets(confirm_id TEXT PRIMARY KEY, order_id TEXT, action TEXT, result TEXT, created_at TEXT);
"""
JSON_COLS = {"fares", "data"}


def db_path():
    """返回 Agent 本地数据库路径；同时确保可变数据目录存在。"""
    S.VAR_DIR.mkdir(parents=True, exist_ok=True)
    return S.VAR_DIR / "air.db"


@contextmanager
def connect():
    """提供自动提交和关闭的 SQLite 连接；适合独立读写，不保证读改写互斥。"""
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@contextmanager
def transaction():
    """写事务：BEGIN IMMEDIATE 先拿写锁，事务内的读-改-写不会被其他线程/进程穿插。"""
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _row(r):
    if r is None:
        return None
    d = dict(r)
    for k in JSON_COLS & d.keys():
        d[k] = json.loads(d[k])
    return d


def init(force: bool = False):
    """初始化表结构和确定性演示数据；同日重复调用保留状态，跨天或强制模式重建种子。"""
    with _init_lock, connect() as c:
        c.executescript(SCHEMA)
        now = S.now()
        seeded = c.execute("SELECT value FROM meta WHERE key='seeded'").fetchone()
        # 同一天重复 init 保留已有数据；跨天（种子是以「今天」为基准生成的）则重新生成
        if seeded and not force and datetime.fromisoformat(seeded["value"]).date() >= now.date():
            return
        for t in ("flights", "orders", "profiles", "fee_rules", "rules"):
            c.execute(f"DELETE FROM {t}")
        fixture = load_demo_seed(now)
        fl, od = fixture["flights"], fixture["orders"]
        c.executemany("INSERT INTO flights VALUES(:flight_no,:date,:airline,:origin,:dest,:origin_city,"
                      ":dest_city,:dep_time,:duration_min,:status,:delay_min,:fares)",
                      [{**f, "fares": json.dumps(f["fares"])} for f in fl])
        c.executemany("INSERT INTO orders VALUES(:order_id,:user_id,:passenger,:flight_no,:date,:airline,"
                      ":cabin,:fare_product,:fare,:tax,:status,:ticket_no)", od)
        c.executemany("INSERT INTO profiles VALUES(:user_id,:name,:tier,:data)",
                      [{**p, "data": json.dumps(p["data"], ensure_ascii=False)} for p in fixture["profiles"]])
        c.executemany("INSERT INTO fee_rules VALUES(?,?,?)",
                      [(row["airline"], row["fare_product"], json.dumps(row["data"])) for row in fixture["fee_rules"]])
        c.executemany("INSERT INTO rules VALUES(:id,:airline,:cabin,:fare_product,:scenario,:title,:content,:ts)",
                      [{**r, "ts": now.isoformat()} for r in fixture["policy_rules"]])
        c.execute("INSERT OR REPLACE INTO meta VALUES('seeded', ?)", (now.isoformat(),))
        _bump_rules_version(c)


def _all(sql, args=()):
    with connect() as c:
        return [_row(r) for r in c.execute(sql, args).fetchall()]


def _one(sql, args=()):
    with connect() as c:
        return _row(c.execute(sql, args).fetchone())


def get_order(order_id):
    """按订单号读取订单并解析 JSON 字段；不存在时返回空值。"""
    return _one("SELECT * FROM orders WHERE order_id=?", (order_id,))


def list_orders(user_id=None):
    """按用户或全量读取订单；用户视图按航班日期排序。"""
    if user_id is not None:
        return _all("SELECT * FROM orders WHERE user_id=? ORDER BY date", (user_id,))
    return _all("SELECT * FROM orders ORDER BY order_id")


def update_order(order_id, conn=None, **fields):
    """只更新白名单内的订单字段；可加入调用方事务以保证出票原子性。"""
    allowed = {"flight_no", "date", "fare", "status", "ticket_no"}
    if not fields or not set(fields) <= allowed:
        raise ValueError(f"update_order 只允许修改 {sorted(allowed)}，收到 {sorted(fields)}")
    sets = ", ".join(f"{k}=?" for k in fields)
    sql, args = f"UPDATE orders SET {sets} WHERE order_id=?", (*fields.values(), order_id)
    if conn is not None:          # 在调用方的事务里执行
        conn.execute(sql, args)
        return
    with connect() as c:
        c.execute(sql, args)


def get_flight(flight_no, date):
    """按航班号和日期读取航班；不存在时返回空值。"""
    return _one("SELECT * FROM flights WHERE flight_no=? AND date=?", (flight_no, date))


def list_flights(origin=None, dest=None, date=None):
    """按可选航线和日期筛选航班；结果按起飞时间排序。"""
    sql, args = "SELECT * FROM flights WHERE 1=1", []
    for col, val in (("origin", origin), ("dest", dest), ("date", date)):
        if val is not None:
            sql += f" AND {col}=?"
            args.append(val)
    return _all(sql + " ORDER BY date, dep_time", args)


def set_flight_status(flight_no, date, status, delay_min=0):
    """更新航班状态和延误分钟；非延误状态会清零延误字段。"""
    if status not in {"scheduled", "delayed", "cancelled"}:
        raise ValueError(f"非法航班状态：{status}")
    with connect() as c:
        c.execute("UPDATE flights SET status=?, delay_min=? WHERE flight_no=? AND date=?",
                  (status, delay_min if status == "delayed" else 0, flight_no, date))


def get_profile(user_id, conn=None):
    """读取用户画像并解析内部 JSON；可复用写事务连接保证读改写一致。"""
    if conn is not None:
        return _row(conn.execute("SELECT * FROM profiles WHERE user_id=?", (user_id,)).fetchone())
    return _one("SELECT * FROM profiles WHERE user_id=?", (user_id,))


def list_profiles():
    """按用户标识列出全部画像；供初始化和评测校验使用。"""
    return _all("SELECT * FROM profiles ORDER BY user_id")


def save_profile(user_id, data, conn=None):
    """保存用户画像 JSON；可复用调用方写事务避免并发计数丢失。"""
    sql, args = "UPDATE profiles SET data=? WHERE user_id=?", (json.dumps(data, ensure_ascii=False), user_id)
    if conn is not None:
        conn.execute(sql, args)
        return
    with connect() as c:
        c.execute(sql, args)


def get_fee_rule(airline, fare_product):
    """读取航司和票种对应的费率表；未配置时返回空值并由引擎报错。"""
    r = _one("SELECT data FROM fee_rules WHERE airline=? AND fare_product=?", (airline, fare_product))
    return r["data"] if r else None


def list_rules(airline=None, fare_product=None, scenario=None):
    """按可选业务维度筛选规则；结果按规则标识稳定排序。"""
    sql, args = "SELECT * FROM rules WHERE 1=1", []
    for col, val in (("airline", airline), ("fare_product", fare_product), ("scenario", scenario)):
        if val is not None:
            sql += f" AND {col}=?"
            args.append(val)
    return _all(sql + " ORDER BY id", args)


def get_rule(rule_id):
    """按规则标识读取规则；用于补齐计价依据和核验引用。"""
    return _one("SELECT * FROM rules WHERE id=?", (rule_id,))


def _bump_rules_version(c):
    """规则版本号存在 meta 表里，跨进程共享；检索索引据此判断是否需要重建。"""
    row = c.execute("SELECT value FROM meta WHERE key='rules_version'").fetchone()
    c.execute("INSERT OR REPLACE INTO meta VALUES('rules_version', ?)", (str(int(row["value"]) + 1 if row else 1),))


def rules_version() -> int:
    """读取跨进程共享的规则版本；检索索引据此判断缓存是否失效。"""
    r = _one("SELECT value FROM meta WHERE key='rules_version'")
    return int(r["value"]) if r else 0


def upsert_rule(rule: dict):
    """新增或覆盖规则并递增版本；版本与规则写入在同一事务提交。"""
    with connect() as c:
        _bump_rules_version(c)
        c.execute("INSERT OR REPLACE INTO rules VALUES(:id,:airline,:cabin,:fare_product,:scenario,:title,"
                  ":content,:ts)", {**rule, "ts": S.now().isoformat()})


def delete_rule(rule_id):
    """删除规则并递增版本；确保其他进程下次检索重建索引。"""
    with connect() as c:
        _bump_rules_version(c)
        c.execute("DELETE FROM rules WHERE id=?", (rule_id,))
