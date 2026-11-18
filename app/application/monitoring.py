"""持久化低价监控、价格观测和站内提醒历史；不发送外部通知。"""
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import (
    FlightRecord,
    PriceAlertRecord,
    PriceObservationRecord,
    PriceWatchRecord,
    utcnow,
)
from app.application.seed import PRODUCTS, TAX


class MonitoringError(Exception):
    """可映射为版本化 HTTP 错误的监控业务异常。"""

    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _as_utc(value: datetime | None) -> datetime | None:
    """为 SQLite 读出的 naive UTC 时间恢复时区标记。"""
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _watch_out(watch: PriceWatchRecord, flight: FlightRecord | None = None) -> dict:
    """序列化监控配置和创建时服务端基线。"""
    return {"watch_id": watch.watch_id, "user_id": watch.user_id, "flight_no": watch.flight_no,
            "date": watch.date, "fare_product": watch.fare_product, "cabin": watch.cabin,
            "origin": flight.origin if flight else None, "dest": flight.dest if flight else None,
            "origin_city": flight.origin_city if flight else None,
            "dest_city": flight.dest_city if flight else None,
            "baseline_fare": watch.baseline_fare, "baseline_tax": watch.baseline_tax,
            "baseline_total": watch.baseline_total, "target_total": watch.target_total,
            "percentage_threshold": watch.percentage_threshold, "currency": watch.currency,
            "active": watch.active, "last_evaluated_at": _as_utc(watch.last_evaluated_at),
            "created_at": _as_utc(watch.created_at), "updated_at": _as_utc(watch.updated_at)}


def _observation_out(observation: PriceObservationRecord) -> dict:
    """序列化单次人工或调度价格观测。"""
    return {"observation_id": observation.observation_id, "watch_id": observation.watch_id,
            "source": observation.source, "status": observation.status, "fare": observation.fare,
            "tax": observation.tax, "total": observation.total, "currency": observation.currency,
            "created_at": _as_utc(observation.created_at)}


def _alert_out(alert: PriceAlertRecord, watch: PriceWatchRecord) -> dict:
    """生成 DSH 历史可直接展示的站内提醒，不宣称已发送外部通知。"""
    drop = alert.baseline_total - alert.observed_total
    drop_percentage = round(drop * 100 / alert.baseline_total, 2) if alert.baseline_total else 0
    return {"alert_id": alert.alert_id, "watch_id": alert.watch_id,
            "observation_id": alert.observation_id, "user_id": alert.user_id,
            "flight_no": watch.flight_no, "date": watch.date, "fare_product": watch.fare_product,
            "cabin": watch.cabin, "trigger": alert.trigger, "baseline_total": alert.baseline_total,
            "observed_total": alert.observed_total, "drop_amount": drop,
            "drop_percentage": drop_percentage, "currency": alert.currency, "message": alert.message,
            "delivery": "dsh_history", "created_at": _as_utc(alert.created_at)}


async def create_watch(user_id: str, flight_no: str, date: str, fare_product: str,
                       target_total: int | None = None,
                       percentage_threshold: float | None = None) -> dict:
    """以当前 SQL 总价创建持久化基线；目标价与百分比阈值至少配置一个。"""
    if target_total is None and percentage_threshold is None:
        raise MonitoringError("THRESHOLD_REQUIRED", "请至少设置目标总价或降价百分比", 422)
    if target_total is not None and target_total <= 0:
        raise MonitoringError("INVALID_TARGET", "目标总价必须大于零", 422)
    if percentage_threshold is not None and not 0 < percentage_threshold <= 100:
        raise MonitoringError("INVALID_PERCENTAGE", "降价百分比必须大于零且不超过一百", 422)
    now = utcnow()
    watch_id = f"watch_{uuid.uuid4().hex}"
    async with SessionFactory() as session:
        flight = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == flight_no.upper(), FlightRecord.date == date))
        if flight is None:
            raise MonitoringError("FLIGHT_NOT_FOUND", "航班不存在", 404)
        if flight.status != "scheduled" or fare_product not in (flight.fares or {}):
            raise MonitoringError("FARE_UNAVAILABLE", "该航班票价当前不可监控")
        baseline_fare = int(flight.fares[fare_product])
        cabin = PRODUCTS.get(fare_product, (fare_product, fare_product))[0]
        watch = PriceWatchRecord(watch_id=watch_id, user_id=user_id, flight_no=flight.flight_no,
                                 date=flight.date, fare_product=fare_product, cabin=cabin,
                                 baseline_fare=baseline_fare, baseline_tax=TAX,
                                 baseline_total=baseline_fare + TAX, target_total=target_total,
                                 percentage_threshold=percentage_threshold, currency="CNY", active=True,
                                 last_evaluated_at=None, created_at=now, updated_at=now)
        session.add(watch)
        await session.commit()
        return _watch_out(watch, flight)


async def list_watches(user_id: str) -> dict:
    """按创建时间倒序列出当前主体的监控，管理员也不能读取他人监控。"""
    async with SessionFactory() as session:
        watches = list(await session.scalars(select(PriceWatchRecord).where(
            PriceWatchRecord.user_id == user_id).order_by(
                PriceWatchRecord.created_at.desc(), PriceWatchRecord.watch_id.desc())))
        out = []
        for watch in watches:
            flight = await session.scalar(select(FlightRecord).where(
                FlightRecord.flight_no == watch.flight_no, FlightRecord.date == watch.date))
            out.append(_watch_out(watch, flight))
        return {"watches": out, "total": len(out)}


async def _owned_watch(session, watch_id: str, user_id: str | None, *, for_update: bool = False):
    """人工路径核验所有权；调度路径以 None 显式表示后端内部评估。"""
    watch = await session.get(PriceWatchRecord, watch_id, with_for_update=for_update)
    if watch is None or (user_id is not None and watch.user_id != user_id):
        raise MonitoringError("WATCH_NOT_FOUND", "价格监控不存在或不属于当前用户", 404)
    return watch


async def get_watch(watch_id: str, user_id: str, *, history_limit: int = 50) -> dict:
    """读取自有监控及最近观测、站内提醒历史。"""
    async with SessionFactory() as session:
        watch = await _owned_watch(session, watch_id, user_id)
        flight = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == watch.flight_no, FlightRecord.date == watch.date))
        observations = list(await session.scalars(select(PriceObservationRecord).where(
            PriceObservationRecord.watch_id == watch_id).order_by(
                PriceObservationRecord.created_at.desc(), PriceObservationRecord.observation_id.desc()
            ).limit(history_limit)))
        alerts = list(await session.scalars(select(PriceAlertRecord).where(
            PriceAlertRecord.watch_id == watch_id).order_by(
                PriceAlertRecord.created_at.desc(), PriceAlertRecord.alert_id.desc()).limit(history_limit)))
        return {**_watch_out(watch, flight),
                "observations": [_observation_out(row) for row in observations],
                "alerts": [_alert_out(row, watch) for row in alerts]}


async def evaluate_watch(watch_id: str, user_id: str | None = None, *, source: str = "manual") -> dict:
    """持久化一次观测并按 OR 阈值生成去重站内提醒；不可用观测不产生价格提醒。"""
    if source not in {"manual", "scheduled"}:
        raise ValueError("source must be manual or scheduled")
    now = utcnow()
    async with SessionFactory() as session:
        watch = await _owned_watch(session, watch_id, user_id, for_update=True)
        if not watch.active:
            raise MonitoringError("WATCH_INACTIVE", "价格监控已停用")
        flight = await session.scalar(select(FlightRecord).where(
            FlightRecord.flight_no == watch.flight_no, FlightRecord.date == watch.date))
        available = (flight is not None and flight.status == "scheduled"
                     and watch.fare_product in (flight.fares or {}))
        fare = int(flight.fares[watch.fare_product]) if available else None
        total = fare + TAX if fare is not None else None
        observation = PriceObservationRecord(observation_id=f"obs_{uuid.uuid4().hex}",
                                             watch_id=watch.watch_id, source=source,
                                             status="OBSERVED" if available else "UNAVAILABLE",
                                             fare=fare, tax=TAX if available else None, total=total,
                                             currency=watch.currency, created_at=now)
        watch.last_evaluated_at, watch.updated_at = now, now
        session.add(observation)
        await session.flush()

        alert = None
        deduplicated_alert_id = None
        if total is not None:
            target_met = watch.target_total is not None and total <= watch.target_total
            percentage_limit = (Decimal(watch.baseline_total) *
                                (Decimal(100) - Decimal(str(watch.percentage_threshold or 0))) / Decimal(100))
            percentage_met = (watch.percentage_threshold is not None
                              and Decimal(total) <= percentage_limit)
            if target_met or percentage_met:
                trigger = ("TARGET_AND_PERCENTAGE" if target_met and percentage_met
                           else "TARGET" if target_met else "PERCENTAGE")
                dedupe_key = f"{trigger}:{total}"
                # 主键由业务去重键确定，数据库唯一约束兜底并发人工/调度评估。
                digest = hashlib.sha256(f"{watch.watch_id}:{dedupe_key}".encode()).hexdigest()
                alert_id = f"alert_{digest[:40]}"
                existing = await session.get(PriceAlertRecord, alert_id)
                if existing:
                    deduplicated_alert_id = existing.alert_id
                else:
                    candidate = PriceAlertRecord(
                        alert_id=alert_id, watch_id=watch.watch_id, observation_id=observation.observation_id,
                        user_id=watch.user_id, trigger=trigger, dedupe_key=dedupe_key,
                        baseline_total=watch.baseline_total, observed_total=total, currency=watch.currency,
                        message=(f"{watch.flight_no} {watch.date} {watch.fare_product} 总价降至 "
                                 f"{total} {watch.currency}（基线 {watch.baseline_total}）"), created_at=now)
                    try:
                        # 候选必须在保存点内加入：失败时回滚只吞掉提醒，观测与评估时间仍要提交。
                        async with session.begin_nested():
                            session.add(candidate)
                            await session.flush()
                        alert = candidate
                    except IntegrityError:
                        deduplicated_alert_id = alert_id
        await session.commit()
        return {"watch": _watch_out(watch, flight), "observation": _observation_out(observation),
                "alert": _alert_out(alert, watch) if alert else None,
                "deduplicated_alert_id": deduplicated_alert_id}


async def evaluate_all_watches() -> dict:
    """后端运行时评估全部有效监控；每条监控独立事务，单条失败不影响其余监控。"""
    async with SessionFactory() as session:
        watch_ids = list(await session.scalars(select(PriceWatchRecord.watch_id).where(
            PriceWatchRecord.active.is_(True)).order_by(PriceWatchRecord.watch_id)))
    evaluated = 0
    alerts = 0
    failed = 0
    for watch_id in watch_ids:
        try:
            result = await evaluate_watch(watch_id, source="scheduled")
        except Exception:                      # noqa: BLE001 - 单条监控失败必须隔离
            failed += 1
            logging.getLogger(__name__).exception("watch evaluation failed: %s", watch_id)
            continue
        evaluated += 1
        alerts += int(result["alert"] is not None)
    return {"evaluated": evaluated, "alerts": alerts, "failed": failed}


async def list_alerts(user_id: str, *, limit: int = 100) -> dict:
    """按时间倒序返回当前主体的站内提醒历史及航班上下文。"""
    async with SessionFactory() as session:
        rows = (await session.execute(select(PriceAlertRecord, PriceWatchRecord).join(
            PriceWatchRecord, PriceWatchRecord.watch_id == PriceAlertRecord.watch_id).where(
                PriceAlertRecord.user_id == user_id).order_by(
                    PriceAlertRecord.created_at.desc(), PriceAlertRecord.alert_id.desc()).limit(limit))).all()
        return {"alerts": [_alert_out(alert, watch) for alert, watch in rows], "total": len(rows)}
