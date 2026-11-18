"""面向乘客的客服案件与报价确认 API。"""
import json
import uuid
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.application.agents import orchestrator as legacy_graph

from app.adapters.inbound.http.auth import Principal, get_principal
from app.adapters.outbound.postgres.database import SessionFactory
from app.adapters.outbound.postgres.models import (CaseEventRecord, OrderRecord, OutboxRecord,
                                                           QuoteRecord, ServiceCaseRecord)
from app.adapters.outbound.redis.streams import Streams
from app.application.cases.service import (
    create_confirmed_operation,
    create_requote,
    record_case_event,
    utcnow,
)

router = APIRouter(prefix="/api/v1", tags=["cases"])
TERMINAL_CASE_STATES = {"PROPOSED", "NEEDS_INFORMATION", "WAITING_CONFIRMATION", "HUMAN_REVIEW",
                       "COMPLETED", "CANCELLED", "RESULT_UNKNOWN"}
_CANCEL_PHRASES = {"取消", "取消办理", "暂不办理", "不办了"}


def is_cancel_request(message: str) -> bool:
    """识别有限的明确取消短语；普通对话不能误取消待确认报价。"""
    return message.strip().rstrip("。！! ") in _CANCEL_PHRASES


def _stream_id_after(candidate: str, cursor: str) -> bool:
    if cursor.startswith("db-"):
        return True
    try:
        return tuple(map(int, candidate.split("-", 1))) > tuple(map(int, cursor.split("-", 1)))
    except (ValueError, TypeError):
        return True


class StrictModel(BaseModel):
    """禁止案件接口请求携带未知字段；保证输入校验失败可见。"""
    model_config = ConfigDict(extra="forbid")


class CaseCreateRequest(StrictModel):
    """约束新建案件的初始诉求和可选订单；订单归属在路由中核验。"""
    message: str = Field(min_length=1, max_length=2000)
    order_id: str | None = Field(default=None, min_length=3, max_length=64)


class CaseMessageRequest(StrictModel):
    """约束追加到既有案件的用户消息；恢复上下文由服务端会话决定。"""
    message: str = Field(min_length=1, max_length=2000)


class ConfirmQuoteRequest(StrictModel):
    """约束报价确认号和幂等键；两者分别保护确认重放与交易重复提交。"""
    confirmation_id: str = Field(min_length=8, max_length=64)
    idempotency_key: str = Field(min_length=8, max_length=128)


def _http_error(code: str, message: str, status_code: int, details: dict | None = None):
    return HTTPException(status_code=status_code, detail={"code": code, "message": message, "details": details or {}})


async def _owned_case(case_id: str, user_id: str) -> ServiceCaseRecord:
    async with SessionFactory() as session:
        case = await session.get(ServiceCaseRecord, case_id)
        if case is None or case.user_id != user_id:
            raise _http_error("NOT_FOUND", "案件不存在", 404)
        return case


def _case_outbox(session, payload: dict) -> str:
    event_id = f"evt_{uuid.uuid4().hex}"
    session.add(OutboxRecord(event_id=event_id, topic="case.turn", aggregate_id=payload["case_id"],
                             payload=payload, created_at=utcnow()))
    return event_id


@router.post("/cases", status_code=status.HTTP_202_ACCEPTED)
async def create_case(request: CaseCreateRequest, principal: Principal = Depends(get_principal)):
    """创建属于当前用户的案件并排队首轮处理；案件与 Outbox 同事务提交。"""
    now = utcnow()
    session_id, case_id = f"s_{uuid.uuid4().hex}", f"case_{uuid.uuid4().hex}"
    async with SessionFactory() as session:
        if request.order_id:
            order = await session.get(OrderRecord, request.order_id)
            if order is None or order.user_id != principal.user_id:
                raise _http_error("ORDER_NOT_FOUND", "订单不存在或不属于当前用户", 404)
        case = ServiceCaseRecord(case_id=case_id, user_id=principal.user_id,
                                 order_id=request.order_id, status="OPEN", intent=None,
                                 session_id=session_id, created_at=now, updated_at=now,
                                 current_quote_id=None, result={})
        session.add(case)
        task_id = _case_outbox(session, {"case_id": case_id, "session_id": session_id,
                                         "user_id": principal.user_id, "message": request.message,
                                         "order_id": request.order_id})
        await session.commit()
    return {"case_id": case_id, "status": "OPEN", "task_id": task_id}


async def _case_payload(session, case: ServiceCaseRecord) -> dict:
    """序列化案件和报价，供详情与当前用户最新案件共用。"""
    quotes = await session.scalars(select(QuoteRecord).where(QuoteRecord.case_id == case.case_id)
                                   .order_by(QuoteRecord.created_at))
    return {"case_id": case.case_id, "order_id": case.order_id, "status": case.status,
            "intent": case.intent, "created_at": case.created_at, "updated_at": case.updated_at,
            "result": case.result, "quotes": [{"quote_id": q.quote_id, "action": q.action,
            "amount": q.amount, "currency": q.currency, "status": q.status,
            "expires_at": q.expires_at, "details": q.details} for q in quotes]}


@router.get("/cases/latest")
async def get_latest_case(principal: Principal = Depends(get_principal)):
    """返回当前用户最近创建的案件；兼容原生 DSH 对话未携带本地案件 ID 的场景。"""
    async with SessionFactory() as session:
        case = await session.scalar(select(ServiceCaseRecord)
                                    .where(ServiceCaseRecord.user_id == principal.user_id)
                                    .order_by(ServiceCaseRecord.created_at.desc()).limit(1))
        if case is None:
            raise _http_error("NOT_FOUND", "当前用户尚无案件", 404)
        return await _case_payload(session, case)


@router.get("/cases/{case_id}")
async def get_case(case_id: str, principal: Principal = Depends(get_principal)):
    """读取自有案件及按时间排序的报价；他人案件统一按不存在处理。"""
    async with SessionFactory() as session:
        case = await session.get(ServiceCaseRecord, case_id)
        if case is None or case.user_id != principal.user_id:
            raise _http_error("NOT_FOUND", "案件不存在", 404)
        return await _case_payload(session, case)


@router.post("/cases/{case_id}/messages", status_code=status.HTTP_202_ACCEPTED)
async def add_case_message(case_id: str, request: CaseMessageRequest,
                           principal: Principal = Depends(get_principal)):
    """追加对话或恢复待追问会话；待确认阶段只允许显式取消或通过确认接口办理。"""
    case = await _owned_case(case_id, principal.user_id)
    pending = legacy_graph.pending_interrupt(case.session_id)
    if pending and pending.get("kind") == "confirm":
        if is_cancel_request(request.message):
            if not case.current_quote_id:
                raise _http_error("CANCELLATION_REJECTED", "当前没有可取消的报价", 409)
            async with SessionFactory() as session:
                quote = await session.get(QuoteRecord, case.current_quote_id, with_for_update=True)
                current_case = await session.get(ServiceCaseRecord, case_id, with_for_update=True)
                if quote is None or quote.status not in {"OFFERED", "REQUOTE_REQUIRED"}:
                    raise _http_error("CANCELLATION_REJECTED", "该报价已进入办理流程，无法取消", 409)
                offered = list(await session.scalars(select(QuoteRecord).where(
                    QuoteRecord.case_id == case_id,
                    QuoteRecord.status.in_(["OFFERED", "REQUOTE_REQUIRED"]))))
                for offered_quote in offered:
                    offered_quote.status = "CANCELLED"
                if current_case:
                    current_case.status = "CANCELLED"
                    current_case.updated_at = utcnow()
                await session.commit()
            quote_ids = [item.quote_id for item in offered]
            await record_case_event(case_id, "case.cancelled", {"quote_id": case.current_quote_id,
                                                                 "quote_ids": quote_ids})
            return {"case_id": case_id, "status": "CANCELLED", "quote_id": case.current_quote_id,
                    "quote_ids": quote_ids}
        raise _http_error("CONFIRMATION_REQUIRED", "请使用报价确认接口办理已报价方案", 409)
    payload = {"case_id": case.case_id, "session_id": case.session_id,
               "user_id": principal.user_id, "message": request.message, "order_id": case.order_id}
    if pending:
        payload["resume_payload"] = {"value": request.message}
    async with SessionFactory() as session:
        task_id = _case_outbox(session, payload)
        await session.commit()
    return {"case_id": case_id, "status": "PROCESSING", "task_id": task_id}


@router.get("/cases/{case_id}/events")
async def stream_case_events(case_id: str, request: Request, principal: Principal = Depends(get_principal),
                             last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
                             after: str | None = Query(default=None)):
    """以 SSE 推送案件事件并支持游标续传；实时流为空时回源数据库，终态空闲后退出。"""
    await _owned_case(case_id, principal.user_id)
    initial_cursor = after or last_event_id or "0-0"

    async def emit():
        """生成 SSE 事件流并维护双侧游标；断连或终态后按顺序关闭流客户端。"""
        streams = Streams()
        cursor = initial_cursor
        fallback_cursor = int(cursor.removeprefix("db-") or 0) if cursor.startswith("db-") else 0
        idle = 0
        try:
            while not await request.is_disconnected():
                try:
                    records = await streams.read_case_events(case_id, cursor, block_ms=1200)
                except Exception:
                    records = []
                if records:
                    for _, messages in records:
                        for stream_id, values in messages:
                            cursor = stream_id
                            try:
                                body = json.loads(values.get("payload", "{}"))
                            except json.JSONDecodeError:
                                body = {"message": "事件内容格式错误"}
                            yield f"id: {stream_id}\nevent: {values.get('event', 'message')}\ndata: {json.dumps(body, ensure_ascii=False, default=str)}\n\n"
                    idle = 0
                    continue
                async with SessionFactory() as session:
                    rows = await session.scalars(select(CaseEventRecord).where(
                        CaseEventRecord.case_id == case_id, CaseEventRecord.id > fallback_cursor
                    ).order_by(CaseEventRecord.id).limit(100))
                    fallback_rows = list(rows)
                    case = await session.get(ServiceCaseRecord, case_id)
                    case_status = case.status if case else "COMPLETED"
                if fallback_rows:
                    for row in fallback_rows:
                        fallback_cursor = row.id
                        if row.stream_id and not _stream_id_after(row.stream_id, cursor):
                            continue
                        payload = json.dumps(row.payload, ensure_ascii=False, default=str)
                        cursor = row.stream_id or f"db-{row.id}"
                        yield f"id: {cursor}\nevent: {row.event_type}\ndata: {payload}\n\n"
                    continue
                idle += 1
                if case_status in TERMINAL_CASE_STATES and idle >= 2:
                    break
                if idle % 10 == 0:
                    yield ": keep-alive\n\n"
        finally:
            await streams.close()

    return StreamingResponse(emit(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/quotes/{quote_id}/confirm", status_code=status.HTTP_202_ACCEPTED)
async def confirm_quote(quote_id: str, request: ConfirmQuoteRequest,
                       principal: Principal = Depends(get_principal)):
    """确认报价并创建异步办理操作；价格越界时生成新报价并要求再次确认。"""
    try:
        result = await create_confirmed_operation(quote_id, principal.user_id,
                                                  request.confirmation_id, request.idempotency_key)
    except LookupError as exc:
        raise _http_error("NOT_FOUND", str(exc), 404) from exc
    except PermissionError as exc:
        raise _http_error("NOT_FOUND", str(exc), 404) from exc
    except ValueError as exc:
        raise _http_error("CONFIRMATION_REJECTED", str(exc), 409) from exc
    if result["status"] == "REQUOTE_REQUIRED":
        requote = await create_requote(quote_id, result["current_pricing"])
        raise _http_error("REQUOTE_REQUIRED", result["reason"], 409, requote)
    return result
