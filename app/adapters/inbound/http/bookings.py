"""Listing 快照预订和幂等 Mock Payment API。"""
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from app.adapters.inbound.http.auth import Principal, get_principal
from app.application import booking as booking_service
from app.application.booking import BookingError

router = APIRouter(prefix="/api/v1", tags=["bookings"])


class StrictModel(BaseModel):
    """禁止客户端注入用户、金额、币种或订单状态等未知字段。"""
    model_config = ConfigDict(extra="forbid")


class BookingCreateRequest(StrictModel):
    """预订只接收航班、日期、票价产品和乘客；价格由服务端 SQL 快照决定。"""
    flight_no: str = Field(min_length=2, max_length=16)
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    fare_product: str = Field(min_length=1, max_length=40)
    passenger: str = Field(min_length=1, max_length=160)


class MockPaymentRequest(StrictModel):
    """模拟支付必须携带幂等键；请求不含任何金额或支付账户信息。"""
    idempotency_key: str = Field(min_length=8, max_length=128)


def _raise_http(exc: BookingError):
    return HTTPException(exc.status_code, detail={"code": exc.code, "message": exc.message, "details": {}})


@router.post("/bookings", status_code=status.HTTP_201_CREATED)
async def create_booking(request: BookingCreateRequest, principal: Principal = Depends(get_principal)):
    """以当前 principal 和服务端票价快照创建 PENDING_PAYMENT 预订。"""
    try:
        return await booking_service.create_booking(principal.user_id, request.flight_no, request.date,
                                                    request.fare_product, request.passenger)
    except BookingError as exc:
        raise _raise_http(exc) from exc


@router.get("/bookings/{booking_id}")
async def get_booking(booking_id: str, principal: Principal = Depends(get_principal)):
    """读取当前主体自有预订；其他用户的预订返回 404。"""
    try:
        return await booking_service.get_booking(booking_id, principal.user_id)
    except BookingError as exc:
        raise _raise_http(exc) from exc


@router.post("/bookings/{booking_id}/pay")
async def pay_booking(booking_id: str, request: MockPaymentRequest,
                      principal: Principal = Depends(get_principal)):
    """执行不触及真实资金的模拟支付，并以持久化幂等键防止重复出票。"""
    try:
        return await booking_service.pay_booking(booking_id, principal.user_id, request.idempotency_key)
    except BookingError as exc:
        raise _raise_http(exc) from exc
