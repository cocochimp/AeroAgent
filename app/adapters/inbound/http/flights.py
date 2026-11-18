"""基于本地 SQL 航班快照的 Listing 查询，不调用真实航司或库存。"""
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from app.adapters.inbound.http.auth import Principal, get_principal
from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import FlightRecord
from app.application.seed import PRODUCTS, TAX

router = APIRouter(prefix="/api/v1", tags=["flights"])


def _availability(flight: FlightRecord, fares: list[dict]) -> tuple[bool, str | None]:
    """把航班和票价快照映射为稳定的可预订状态；不代表实时库存。"""
    from app import config as S

    if flight.date < S.now().date().isoformat():
        return False, "FLIGHT_DEPARTED"
    if flight.status == "cancelled":
        return False, "FLIGHT_CANCELLED"
    if flight.status != "scheduled":
        return False, "FLIGHT_NOT_BOOKABLE"
    if not fares:
        return False, "FARE_UNAVAILABLE"
    return True, None


@router.get("/flights")
async def list_flights(
    principal: Principal = Depends(get_principal),
    origin: Annotated[str | None, Query(min_length=2, max_length=8)] = None,
    dest: Annotated[str | None, Query(min_length=2, max_length=8)] = None,
    date: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    cabin: Annotated[Literal["F", "C", "Y"] | None, Query()] = None,
    flight_no: Annotated[str | None, Query(min_length=2, max_length=16)] = None,
):
    """按航线、日期、舱位筛选 SQL 快照；不可用航班仍返回原因供 Listing 展示。"""
    del principal  # 认证依赖负责校验；航班快照对所有登录用户只读。
    filters = []
    if origin:
        filters.append(FlightRecord.origin == origin.strip().upper())
    if dest:
        filters.append(FlightRecord.dest == dest.strip().upper())
    if date:
        filters.append(FlightRecord.date == date)
    if flight_no:
        filters.append(FlightRecord.flight_no == flight_no.strip().upper())
    async with SessionFactory() as session:
        rows = list(await session.scalars(select(FlightRecord).where(*filters).order_by(
            FlightRecord.date, FlightRecord.dep_time, FlightRecord.flight_no, FlightRecord.id)))

    out = []
    for flight in rows:
        fares = []
        for product, amount in sorted((flight.fares or {}).items()):
            fare_cabin = PRODUCTS.get(product, (product, product))[0]
            if cabin and fare_cabin != cabin:
                continue
            fares.append({"fare_product": product, "cabin": fare_cabin, "fare": amount,
                          "tax": TAX, "total": amount + TAX, "currency": "CNY",
                          "available": False})
        if cabin and not fares:
            continue
        available, reason = _availability(flight, fares)
        for fare in fares:
            fare["available"] = available
        out.append({"flight_no": flight.flight_no, "date": flight.date, "airline": flight.airline,
                    "origin": flight.origin, "dest": flight.dest, "origin_city": flight.origin_city,
                    "dest_city": flight.dest_city, "dep_time": flight.dep_time,
                    "duration_min": flight.duration_min, "status": flight.status,
                    "delay_min": flight.delay_min, "available": available,
                    "unavailable_reason": reason, "inventory_source": "local_sql_snapshot",
                    "fares": fares})
    return {"flights": out, "total": len(out)}
