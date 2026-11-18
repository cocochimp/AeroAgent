"""OpenAI 兼容端点：让 DSH 等外部宿主把 AeroAgent 当作模型提供方接入。"""
import json
import logging
import re
import sqlite3
import threading
import time
import uuid
from collections import defaultdict, deque

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app import config as S
from app.adapters.outbound.sqlite import data
from app.application.agents import orchestrator
from app.application.agents.llm import LLMError

router = APIRouter(tags=["openai-compat"])

_ORDER_INTENT = re.compile(r"(订单|order|列表|list)", re.I)
_SERVICING_INTENT = re.compile(r"(退票|改签|refund|change)", re.I)
_MODEL_MODES = {"aeroagent-mock": "mock", "aeroagent-deepseek": "deepseek"}
_TITLE_SYSTEM_PREFIX = "Create a concise title for an AI coding-assistant session from the supplied human messages."
_TITLE_USER_PREFIX = "Generate the session title from this JSON array of human messages:"
_request_times = defaultdict(deque)
_request_lock = threading.Lock()


class CompatMessage(BaseModel):
    """兼容 OpenAI 消息结构；额外字段一律忽略以容忍宿主方言。"""
    model_config = ConfigDict(extra="ignore")
    role: str
    content: str | None = None
    tool_call_id: str | None = None


class CompatRequest(BaseModel):
    """兼容 OpenAI chat/completions 请求体；仅保留 mock 档需要的字段。"""
    model_config = ConfigDict(extra="ignore")
    model: str = "aeroagent-mock"
    messages: list[CompatMessage] = Field(default_factory=list)
    stream: bool = False
    tools: list[dict] = Field(default_factory=list)
    user: str | None = None
    metadata: dict = Field(default_factory=dict)


def _tool_names(request: CompatRequest) -> set[str]:
    return {((t.get("function") or {}).get("name") or "") for t in request.tools}


def _mode_for_model(model: str) -> str:
    try:
        return _MODEL_MODES[model]
    except KeyError as exc:
        raise HTTPException(400, detail={"code": "UNKNOWN_MODEL", "message": f"不支持的模型：{model}"}) from exc


def _is_title_request(request: CompatRequest) -> bool:
    if request.tools:
        return False
    system = any(m.role == "system" and (m.content or "").strip().startswith(_TITLE_SYSTEM_PREFIX)
                 for m in request.messages)
    user = any(m.role == "user" and (m.content or "").strip().startswith(_TITLE_USER_PREFIX)
               for m in request.messages)
    return system and user


def _local_title(request: CompatRequest) -> str:
    """从宿主已提供的消息生成短标题；不进入案件图，也不调用任何模型。"""
    message = next(m for m in reversed(request.messages)
                   if m.role == "user" and (m.content or "").strip().startswith(_TITLE_USER_PREFIX))
    raw = message.content.strip()[len(_TITLE_USER_PREFIX):].strip()
    try:
        entries = json.loads(raw)
        for entry in entries:
            text = entry if isinstance(entry, str) else entry.get("content", "")
            if text and not _is_host_metadata(text):
                return re.sub(r"\s+", " ", text).strip()[:60] or "AeroAgent Session"
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return "AeroAgent Session"


def _is_host_metadata(content: str) -> bool:
    """识别 DSH 注入到 user 角色中的非业务上下文。"""
    return content.strip().startswith(("Time sampled while preparing turn", "<system-reminder>",
                                      "Current runtime context."))


def _last_user(request: CompatRequest) -> str:
    for message in reversed(request.messages):
        if message.role == "user" and message.content:
            if _is_host_metadata(message.content):
                continue
            return message.content
    return ""


def _last_tool_content(request: CompatRequest) -> str | None:
    for message in reversed(request.messages):
        # 新的真实用户诉求表示历史工具轮已结束，不能重复汇总旧工具结果。
        if message.role == "user" and message.content:
            if _is_host_metadata(message.content):
                continue
            return None
        if message.role == "tool" and message.content:
            return message.content
    return None


_ORDER_TOKEN = re.compile(r"@(ORD[0-9A-Za-z]+)")


def _parse_order_id(text: str) -> str | None:
    match = _ORDER_TOKEN.search(text)
    return match.group(1) if match else None


def _header_user_id(raw_request: Request) -> str | None:
    """读取宿主为本机演示注入的身份头；缺失时保持匿名。"""
    value = raw_request.headers.get("x-aeroagent-user")
    if not value:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise HTTPException(400, detail={"code": "INVALID_USER", "message": "用户元数据无效"})
    return value


def _explicit_user_id(request: CompatRequest, header_user: str | None = None) -> str | None:
    value = request.metadata.get("user_id") or request.user or header_user
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise HTTPException(400, detail={"code": "INVALID_USER", "message": "用户元数据无效"})
    return value


def _request_identity(request: CompatRequest, header_user: str | None = None) -> tuple[str | None, str | None]:
    """优先以选中订单的归属确定用户；显式身份与订单冲突时拒绝跨用户访问。"""
    user_id = _explicit_user_id(request, header_user)
    order_id = (request.metadata.get("selected_order_id") or request.metadata.get("order_id")
                or _parse_order_id(_last_user(request)))
    if order_id is not None and not isinstance(order_id, str):
        raise HTTPException(400, detail={"code": "INVALID_ORDER", "message": "订单元数据无效"})
    if not order_id:
        return user_id, None
    try:
        order = data.get_order(order_id)
    except sqlite3.OperationalError:
        # 单元调用方可在未启动投影时模拟案件；真实路由会在写案件前再次核验订单。
        return user_id, order_id
    if order is None:
        raise HTTPException(404, detail={"code": "ORDER_NOT_FOUND", "message": "订单不存在"})
    if user_id and order["user_id"] != user_id:
        raise HTTPException(404, detail={"code": "ORDER_NOT_FOUND", "message": "订单不存在或无权访问"})
    return order["user_id"], order_id


_CASE_FENCE = re.compile(
    r"```aeroagent-case\s*(\{[\s\S]*?\})\s*```|<!--\s*aeroagent-case\s*(\{[\s\S]*?\})\s*-->"
    r"|^\[aeroagent-case\]:\s*#\s*\"case_id=([A-Za-z0-9_]+)(?:\s+user=([A-Za-z0-9_-]+))?\"\s*$",
    re.MULTILINE)


def _latest_case_metadata(request: CompatRequest) -> dict:
    """从宿主回传的最近 assistant 元数据中恢复案件及其既有用户身份。"""
    for message in reversed(request.messages):
        if message.role != "assistant" or not message.content:
            continue
        match = _CASE_FENCE.search(message.content)
        if not match:
            continue
        if match.group(3):
            return {"case_id": match.group(3), "user_id": match.group(4)}
        try:
            payload = json.loads(match.group(1) or match.group(2))
        except json.JSONDecodeError:
            continue
        case_id = payload.get("case_id")
        if isinstance(case_id, str) and case_id.startswith("case_"):
            user_id = payload.get("user_id")
            return {"case_id": case_id, "user_id": user_id if isinstance(user_id, str) else None}
    return {}


def _latest_case_id(request: CompatRequest) -> str | None:
    return _latest_case_metadata(request).get("case_id")


def _case_fence(case_id: str, user_id: str | None = None) -> str:
    """生成不可见、但宿主下一轮会原样回传的案件与用户标记。

    Markdown link-reference definition：渲染时完全隐藏，原始 Markdown 仍留在会话历史里，
    因此不会像 HTML 注释那样在宿主正文中露出内部字段。
    """
    title = f"case_id={case_id}" + (f" user={user_id}" if user_id else "")
    return f'[aeroagent-case]: # "{title}"'


def _quote_payload(quote, case_id: str) -> dict:
    """把报价记录转换为浏览器确认卡所需的稳定字段。"""
    detail = (quote.details or [{}])[0]
    pricing = detail.get("pricing") or {}
    return {"quote_id": quote.quote_id, "case_id": case_id, "order_id": quote.order_id,
            "action": quote.action, "amount": quote.amount, "currency": quote.currency,
            "expires_at": quote.expires_at.isoformat() if quote.expires_at else None,
            "fee_items": detail.get("fee_items", []), "rule_refs": detail.get("rule_refs", []),
            "target": detail.get("target") or pricing.get("target")}


async def _run_servicing_case(message: str, case_id: str | None = None, *, mode="mock",
                              user_id: str | None = None, order_id: str | None = None,
                              strict: bool | None = None) -> dict:
    """创建或恢复真实案件；用户、模式和严格策略仅沿本案请求传递。"""
    from sqlalchemy import select

    from app.adapters.outbound.postgres.database import SessionFactory
    from app.adapters.outbound.postgres.models import QuoteRecord, ServiceCaseRecord
    from app.application.cases.service import run_case_turn, utcnow

    if mode not in {"mock", "offline", "deepseek"}:
        raise HTTPException(400, detail={"code": "UNKNOWN_MODE", "message": "不支持的决策模式"})
    strict = bool(strict) and mode == "deepseek" if strict is not None else mode == "deepseek"
    explicit_order_id = order_id or _parse_order_id(message)
    if explicit_order_id:
        selected_order = data.get_order(explicit_order_id)
        if selected_order is None:
            raise HTTPException(404, detail={"code": "ORDER_NOT_FOUND", "message": "订单不存在"})
        if user_id and selected_order["user_id"] != user_id:
            raise HTTPException(404, detail={"code": "ORDER_NOT_FOUND", "message": "订单不存在或无权访问"})
        user_id = selected_order["user_id"]
    if case_id and not user_id:
        raise HTTPException(400, detail={"code": "USER_REQUIRED", "message": "继续案件前请提供用户身份或选择订单"})
    clean = _ORDER_TOKEN.sub("", message).strip() or message
    case = None
    if case_id:
        async with SessionFactory() as session:
            candidate = await session.get(ServiceCaseRecord, case_id)
        if candidate is None or (user_id and candidate.user_id != user_id):
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "案件不存在"})
        case = candidate
        user_id = case.user_id
        if case.status == "RESULT_UNKNOWN":
            return {"case_id": case.case_id, "user_id": user_id, "status": "RESULT_UNKNOWN",
                    "final": "上一笔办理结果仍待核对，请先核对航司与订单状态；在结果明确前不会创建新案件或新报价。"}
        # 显式切换到另一订单或已结束旧案件时，开始独立的新案件。
        if ((explicit_order_id and case.order_id and explicit_order_id != case.order_id) or
                case.status in {"COMPLETED", "CANCELLED", "HUMAN_REVIEW"}):
            case = None
            case_id = None

    pending = orchestrator.pending_interrupt(case.session_id) if case else None
    if case is None:
        if not user_id:
            raise HTTPException(400, detail={"code": "USER_REQUIRED", "message": "请提供用户身份或选择订单"})
        case_id = f"case_{uuid.uuid4().hex}"
        session_id = f"compat_{uuid.uuid4().hex}"
        resolved_order_id = explicit_order_id
        now = utcnow()
        async with SessionFactory() as session:
            session.add(ServiceCaseRecord(case_id=case_id, user_id=user_id, order_id=resolved_order_id,
                                          status="OPEN", intent=None, session_id=session_id,
                                          created_at=now, updated_at=now,
                                          current_quote_id=None, result={}))
            await session.commit()
    else:
        session_id = case.session_id
        resolved_order_id = explicit_order_id or case.order_id

    if not (pending and pending.get("kind") == "confirm"):
        payload = {"case_id": case_id, "session_id": session_id, "user_id": user_id,
                   "message": clean, "order_id": resolved_order_id, "mode": mode, "strict": strict}
        if pending:
            payload["resume_payload"] = {"value": clean}
        await run_case_turn(payload)

    async with SessionFactory() as session:
        case = await session.get(ServiceCaseRecord, case_id)
        quotes = list(await session.scalars(select(QuoteRecord).where(QuoteRecord.case_id == case_id)
                                            .order_by(QuoteRecord.created_at)))
    out = {"case_id": case_id, "user_id": case.user_id if case else user_id,
           "status": case.status if case else "UNKNOWN"}
    offered = [quote for quote in quotes if quote.status == "OFFERED"]
    if offered:
        out["quotes"] = [_quote_payload(quote, case_id) for quote in offered]
    if pending and pending.get("kind") == "confirm":
        out["final"] = "当前方案仍在等待确认，请使用报价卡选择确认办理或暂不办理。"
    elif case and case.result and case.result.get("interrupt"):
        out["clarify"] = case.result["interrupt"]
    elif case and case.result:
        out["final"] = case.result.get("final") or json.dumps(case.result.get("results", {}), ensure_ascii=False)
    return out


def _render_quote_section(quote: dict) -> str:
    """把内部报价转换为乘客可读的方案区块，不暴露 JSON 或 quote_id。"""
    action = "退票" if quote.get("action") == "REFUND" else "改签"
    amount = quote.get("amount")
    total_label = "预计退款" if action == "退票" else "应付合计"
    currency = "¥" if quote.get("currency", "CNY") == "CNY" else f"{quote.get('currency')} "
    target = quote.get("target") or {}
    rows = []
    if isinstance(target, dict) and target:
        flight = " ".join(str(value) for value in (
            target.get("flight_no"), target.get("date"), target.get("dep_time")) if value)
        if flight:
            rows.append(("改签目标", flight))
    for item in quote.get("fee_items") or []:
        if item.get("name"):
            rows.append((str(item["name"]), f"{currency}{item.get('amount', 0)}"))
    rows.append((total_label, f"{currency}{amount if amount is not None else '—'}"))
    refs = quote.get("rule_refs") or []
    if refs:
        rows.append(("规则依据", "、".join(str(ref) for ref in refs)))
    table = ["| 项目 | 内容 |", "| --- | --- |"]
    table.extend(f"| {label} | {value} |" for label, value in rows)
    return "\n".join([f"### {action}方案", *table,
                      "", "> 方案由服务端运价引擎核对；核对后可在输入框上方确认办理。"])


def _render_case_result(result: dict) -> str:
    """渲染乘客可读方案与不可见的案件恢复元数据。"""
    parts = []
    quotes = result.get("quotes") or ([result["quote"]] if result.get("quote") else [])
    if quotes:
        parts.append("已生成可办理方案，请核对下列费用与依据。")
        parts.extend(_render_quote_section(quote) for quote in quotes)
    elif "clarify" in result:
        question = result["clarify"].get("question") or json.dumps(result["clarify"], ensure_ascii=False)
        parts.append(f"待乘客补充：{question}")
    else:
        final = result.get("final") or "（本轮没有产生答复）"
        parts.append((final.get("text") or json.dumps(final, ensure_ascii=False))
                     if isinstance(final, dict) else str(final))
    if result.get("case_id"):
        parts.append(_case_fence(result["case_id"], result.get("user_id")))
    return "\n\n".join(parts)


async def _completion_content(request: CompatRequest) -> tuple[str, list[dict] | None]:
    """先本地分类宿主流量，再按显式模型档处理业务消息。"""
    mode = _mode_for_model(request.model)
    if _is_title_request(request):
        return _local_title(request), None
    tool_content = _last_tool_content(request)
    if tool_content is not None:
        return f"【AeroAgent】工具返回：{tool_content[:1500]}", None
    if not _last_user(request) and any(m.role == "user" and m.content and _is_host_metadata(m.content)
                                       for m in request.messages):
        return "", None
    case_metadata = _latest_case_metadata(request)
    case_id = case_metadata.get("case_id")
    user_id, selected_order_id = _request_identity(request)
    case_user_id = case_metadata.get("user_id")
    # 没有客票也没有显式身份时，案件元数据就是本轮身份来源（案件号不可猜且仅本人可读）。
    if not user_id and case_user_id:
        user_id = case_user_id
    # 客票上下文优先：乘客在同一会话里换了另一张客票时，旧案件不再适用，直接按新客票开案。
    explicit_user = _explicit_user_id(request)
    if case_id and not user_id:
        raise HTTPException(400, detail={"code": "USER_REQUIRED", "message": "继续案件前请提供用户身份或选择订单"})
    if case_user_id and user_id != case_user_id:
        if explicit_user:
            raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "案件不存在"})
        case_id = None
    names = _tool_names(request)
    if (not case_id and "aeroagent_list_orders" in names and _ORDER_INTENT.search(_last_user(request))
            and not _SERVICING_INTENT.search(_last_user(request))):
        if not user_id:
            raise HTTPException(400, detail={"code": "USER_REQUIRED", "message": "请提供用户身份或选择订单"})
        call = [{"index": 0, "id": f"call_{uuid.uuid4().hex}", "type": "function",
                 "function": {"name": "aeroagent_list_orders",
                              "arguments": json.dumps({"user_id": user_id})}}]
        return "", call
    try:
        result = await _run_servicing_case(_last_user(request), case_id, mode=mode, user_id=user_id,
                                           order_id=selected_order_id, strict=mode == "deepseek")
    except HTTPException:
        raise
    except LLMError:
        raise
    except Exception as exc:                       # noqa: BLE001 - 兜底必须是可重试的业务错误
        logging.getLogger(__name__).exception("compat servicing failed")
        raise HTTPException(503, detail={
            "code": "AGENT_FAILED", "message": "本轮处理失败，请重试",
            "details": {"retryable": True, "type": type(exc).__name__}}) from exc
    return _render_case_result(result), None


def _throttle(raw_request: Request, request: CompatRequest,
              header_user: str | None = None) -> None:
    """按用户隔离一分钟滑动窗口；匿名流量仅按客户端地址共享限额。"""
    # 与业务处理使用同一身份解析；案件 fence 不是可认证的用户凭证。
    user_id = None if _is_title_request(request) else _request_identity(request, header_user)[0]
    host = raw_request.client.host if raw_request.client else "unknown"
    key = f"user:{user_id}" if user_id else f"host:{host}"
    now = time.monotonic()
    limit = S.get()["compat"]["requests_per_minute"]
    with _request_lock:
        recent = _request_times[key]
        while recent and recent[0] <= now - 60:
            recent.popleft()
        if len(recent) >= limit:
            raise HTTPException(429, detail={"code": "RATE_LIMITED", "message": "请求过于频繁，请稍后重试",
                                             "details": {"retryable": True}}, headers={"Retry-After": "60"})
        recent.append(now)


def _usage(content: str) -> dict:
    return {"prompt_tokens": max(1, len(content) // 2), "completion_tokens": max(1, len(content) // 2),
            "total_tokens": max(2, len(content))}


@router.get("/v1/models")
async def list_models():
    """列出兼容端点暴露的模型档；mock 档零 Key 可用。"""
    return {"object": "list", "data": [
        {"id": "aeroagent-mock", "object": "model", "owned_by": "aeroagent"},
        {"id": "aeroagent-deepseek", "object": "model", "owned_by": "aeroagent"},
    ]}


@router.post("/v1/chat/completions")
async def chat_completions(request: CompatRequest, raw_request: Request):
    """OpenAI chat/completions 兼容入口；stream 时按 SSE 分片返回。"""
    _mode_for_model(request.model)
    header_user = _header_user_id(raw_request)
    if header_user and not request.user and not request.metadata.get("user_id"):
        request.user = header_user
    _throttle(raw_request, request)
    try:
        content, tool_calls = await _completion_content(request)
    except LLMError as exc:
        details = {"retryable": exc.retryable}
        if getattr(exc, "case_id", None):
            details["case_id"] = exc.case_id
        detail = {"code": exc.code, "message": str(exc), "details": details}
        raise HTTPException(504 if exc.code == "LLM_TIMEOUT" else 503, detail=detail,
                            headers={"Retry-After": "1"} if exc.retryable else None) from exc
    created = int(time.time())
    base = {"id": f"chatcmpl-{uuid.uuid4().hex}", "created": created, "model": request.model}
    if not request.stream:
        choice = {"index": 0, "finish_reason": "tool_calls" if tool_calls else "stop"}
        if tool_calls:
            choice["message"] = {"role": "assistant", "content": None, "tool_calls": tool_calls}
        else:
            choice["message"] = {"role": "assistant", "content": content}
        return {**base, "object": "chat.completion", "choices": [choice], "usage": _usage(content)}

    async def emit():
        """按 SSE 分片产出兼容 chunk；tool_call 与文本走不同的分片序列。"""
        if tool_calls:
            chunks = [
                {"delta": {"role": "assistant", "tool_calls": [
                    {**tool_calls[0], "function": {**tool_calls[0]["function"], "arguments": ""}}]},
                 "finish_reason": None},
                {"delta": {"tool_calls": [{"index": 0, "function": {
                    "arguments": tool_calls[0]["function"]["arguments"]}}]}, "finish_reason": None},
                {"delta": {}, "finish_reason": "tool_calls"},
            ]
        else:
            chunks = [{"delta": {"role": "assistant", "content": content}, "finish_reason": None},
                      {"delta": {}, "finish_reason": "stop"}]
        for chunk in chunks:
            payload = {**base, "object": "chat.completion.chunk",
                       "choices": [{"index": 0, **chunk}]}
            yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(emit(), media_type="text/event-stream")
