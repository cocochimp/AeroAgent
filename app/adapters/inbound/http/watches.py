"""用户自有低价监控、人工评估与 DSH 站内提醒历史 API。"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.adapters.inbound.http.auth import Principal, get_principal
from app.application import monitoring as monitoring_service
from app.application.monitoring import MonitoringError

router = APIRouter(prefix="/api/v1", tags=["watches"])


class WatchCreateRequest(BaseModel):
    """监控只接收航班、票价产品和阈值；基线、用户和币种均由服务端确定。"""
    model_config = ConfigDict(extra="forbid")

    flight_no: str = Field(min_length=2, max_length=16)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    fare_product: str = Field(min_length=1, max_length=40)
    target_total: int | None = Field(default=None, gt=0)
    percentage_threshold: float | None = Field(default=None, gt=0, le=100)

    @model_validator(mode="after")
    def require_threshold(self):
        """目标总价和百分比至少设置一项；同时设置时任一满足即触发。"""
        if self.target_total is None and self.percentage_threshold is None:
            raise ValueError("target_total or percentage_threshold is required")
        return self


def _raise_http(exc: MonitoringError):
    return HTTPException(exc.status_code, detail={"code": exc.code, "message": exc.message, "details": {}})


@router.post("/watches", status_code=status.HTTP_201_CREATED)
async def create_watch(request: WatchCreateRequest, principal: Principal = Depends(get_principal)):
    """以当前 SQL 票价快照作为基线，创建当前 principal 所有的持久化监控。"""
    try:
        return await monitoring_service.create_watch(
            principal.user_id, request.flight_no, request.date, request.fare_product,
            request.target_total, request.percentage_threshold)
    except MonitoringError as exc:
        raise _raise_http(exc) from exc


@router.get("/watches")
async def list_watches(principal: Principal = Depends(get_principal)):
    """列出当前 principal 的监控；不支持通过参数切换到其他用户。"""
    return await monitoring_service.list_watches(principal.user_id)


@router.get("/watches/alerts")
async def list_alerts(principal: Principal = Depends(get_principal),
                      limit: Annotated[int, Query(ge=1, le=200)] = 100):
    """返回当前 principal 的站内提醒历史；没有外部通知投递语义。"""
    return await monitoring_service.list_alerts(principal.user_id, limit=limit)


@router.post("/watches/{watch_id}/evaluate")
async def evaluate_watch(watch_id: str, principal: Principal = Depends(get_principal)):
    """立即记录一次 manual 观测，并返回新提醒或去重提醒标识。"""
    try:
        return await monitoring_service.evaluate_watch(watch_id, principal.user_id, source="manual")
    except MonitoringError as exc:
        raise _raise_http(exc) from exc


@router.get("/watches/{watch_id}")
async def get_watch(watch_id: str, principal: Principal = Depends(get_principal)):
    """读取自有监控及最近 50 条观测和提醒历史。"""
    try:
        return await monitoring_service.get_watch(watch_id, principal.user_id)
    except MonitoringError as exc:
        raise _raise_http(exc) from exc
