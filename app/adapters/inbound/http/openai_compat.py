"""OpenAI 兼容端点：让 DSH 等外部宿主把 AeroAgent 当作模型提供方接入。"""
import json
import re
import time
import uuid

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.application.agents import orchestrator

router = APIRouter(tags=["openai-compat"])

_ORDER_INTENT = re.compile(r"(订单|order|列表|list)", re.I)


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


def _tool_names(request: CompatRequest) -> set[str]:
    return {((t.get("function") or {}).get("name") or "") for t in request.tools}


def _last_user(request: CompatRequest) -> str:
    for message in reversed(request.messages):
        if message.role == "user" and message.content:
            return message.content
    return ""


def _last_tool_content(request: CompatRequest) -> str | None:
    for message in reversed(request.messages):
        if message.role == "tool" and message.content:
            return message.content
    return None


_ORDER_TOKEN = re.compile(r"@(ORD[0-9A-Za-z]+)")


def _parse_order_id(text: str) -> str | None:
    match = _ORDER_TOKEN.search(text)
    return match.group(1) if match else None


async def _run_servicing_case(message: str) -> dict:
    """在兼容端点内驱动完整案件管线；返回可渲染的结果描述。"""
    from sqlalchemy import select

    from app.adapters.outbound.postgres.database import SessionFactory
    from app.adapters.outbound.postgres.models import QuoteRecord, ServiceCaseRecord
    from app.application.cases.service import run_case_turn, utcnow

    case_id = f"case_{uuid.uuid4().hex}"
    session_id = f"compat_{uuid.uuid4().hex}"
    order_id = _parse_order_id(message)
    clean = _ORDER_TOKEN.sub("", message).strip() or message
    now = utcnow()
    async with SessionFactory() as session:
        session.add(ServiceCaseRecord(case_id=case_id, user_id="u_zhang", order_id=order_id,
                                      status="OPEN", intent=None, session_id=session_id,
                                      created_at=now, updated_at=now,
                                      current_quote_id=None, result={}))
        await session.commit()
    await run_case_turn({"case_id": case_id, "session_id": session_id, "user_id": "u_zhang",
                         "message": clean, "order_id": order_id})
    async with SessionFactory() as session:
        case = await session.get(ServiceCaseRecord, case_id)
        quotes = list(await session.scalars(select(QuoteRecord).where(QuoteRecord.case_id == case_id)))
    out = {"case_id": case_id, "status": case.status if case else "UNKNOWN"}
    quote = next((q for q in quotes if q.quote_id == (case.current_quote_id if case else None)), None)
    if case and case.status == "WAITING_CONFIRMATION" and quote:
        detail = (quote.details or [{}])[0]
        out["quote"] = {"quote_id": quote.quote_id, "case_id": case_id, "action": quote.action,
                        "amount": quote.amount,
                        "fee_items": detail.get("fee_items", []), "rule_refs": detail.get("rule_refs", []),
                        "order_id": quote.order_id}
    elif case and case.result and case.result.get("interrupt"):
        out["clarify"] = case.result["interrupt"]
    elif case and case.result:
        out["final"] = case.result.get("final") or json.dumps(case.result.get("results", {}), ensure_ascii=False)
    return out


def _render_case_result(result: dict) -> str:
    """把案件结果渲染为宿主可读文本；报价用 fenced 标记供客户端插件渲染确认卡。"""
    if "quote" in result:
        fence = json.dumps(result["quote"], ensure_ascii=False)
        return (f"已生成可办理方案，请在下方确认卡操作。\n```aeroagent-quote\n{fence}\n```")
    if "clarify" in result:
        question = result["clarify"].get("question") or json.dumps(result["clarify"], ensure_ascii=False)
        return f"待乘客补充：{question}"
    return str(result.get("final") or "（本轮没有产生答复）")


async def _completion_content(request: CompatRequest) -> tuple[str, list[dict] | None]:
    """决定本轮返回普通文本还是 tool_call；mock 档在宿主提供业务工具时优先委派。"""
    tool_content = _last_tool_content(request)
    if tool_content is not None:
        return f"【AeroAgent】工具返回：{tool_content[:1500]}", None
    names = _tool_names(request)
    if "aeroagent_list_orders" in names and _ORDER_INTENT.search(_last_user(request)):
        call = [{"index": 0, "id": f"call_{uuid.uuid4().hex}", "type": "function",
                 "function": {"name": "aeroagent_list_orders",
                              "arguments": json.dumps({"user_id": "u_zhang"})}}]
        return "", call
    result = await _run_servicing_case(_last_user(request))
    return _render_case_result(result), None


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
async def chat_completions(request: CompatRequest):
    """OpenAI chat/completions 兼容入口；stream 时按 SSE 分片返回。"""
    content, tool_calls = await _completion_content(request)
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
