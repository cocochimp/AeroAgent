#!/usr/bin/env python3
"""对零密钥 lite API 执行改签和退票冒烟流程。"""
import argparse
import asyncio
import json
import uuid
from datetime import date, timedelta

import httpx


def check(response: httpx.Response, expected: int = 200) -> dict:
    """校验 HTTP 状态码并返回 JSON；失败时带请求和响应正文立即中止。"""
    if response.status_code != expected:
        raise AssertionError(f"{response.request.method} {response.request.url}: "
                             f"期望 {expected}，实际 {response.status_code} {response.text}")
    return response.json()


async def order_snapshot(client: httpx.AsyncClient, order_id: str) -> dict:
    """读取订单关键状态快照；用于比较确认前后是否发生预期变化。"""
    payload = check(await client.get("/orders"))
    order = next(item for item in payload["orders"] if item["order_id"] == order_id)
    return {key: order[key] for key in ("status", "flight_no", "date", "ticket_no")}


async def wait_for_quote(client: httpx.AsyncClient, case_id: str, action: str) -> dict:
    """轮询直到指定动作产生有效报价；异常或人工终态会立即失败。"""
    async with asyncio.timeout(60):
        while True:
            case = check(await client.get(f"/cases/{case_id}"))
            quotes = [quote for quote in case["quotes"]
                      if quote["action"] == action and quote["status"] == "OFFERED"]
            if quotes:
                quote = quotes[-1]
                details = quote["details"][0]
                assert details.get("fee_items"), f"报价缺少费用明细：{quote}"
                assert details.get("rule_refs"), f"报价缺少规则引用：{quote}"
                return case, quote
            assert case["status"] not in {"RESULT_UNKNOWN", "HUMAN_REVIEW", "CANCELLED"}, case
            await asyncio.sleep(0.2)


async def wait_for_completion(client: httpx.AsyncClient, case_id: str, order_id: str, expected: str) -> dict:
    """等待案件和订单同时到达预期终态；避免只凭案件状态判断履约完成。"""
    async with asyncio.timeout(60):
        while True:
            case = check(await client.get(f"/cases/{case_id}"))
            order = await order_snapshot(client, order_id)
            if case["status"] == "COMPLETED" and order["status"] == expected:
                return {"case_status": case["status"], "order": order}
            assert case["status"] not in {"RESULT_UNKNOWN", "HUMAN_REVIEW", "CANCELLED"}, case
            await asyncio.sleep(0.2)


async def read_events_until(client: httpx.AsyncClient, case_id: str, target: str, after: str | None = None) -> list[dict]:
    """读取 SSE 直到目标事件；支持从指定游标续传并解析多行数据。"""
    events = []
    params = {"after": after} if after else None
    async with asyncio.timeout(60):
        async with client.stream("GET", f"/cases/{case_id}/events", params=params) as response:
            response.raise_for_status()
            event_id, event_type, data_lines = after, None, []
            async for line in response.aiter_lines():
                if line.startswith("id: "):
                    event_id = line[4:]
                elif line.startswith("event: "):
                    event_type = line[7:]
                elif line.startswith("data: "):
                    data_lines.append(line[6:])
                elif not line and event_type:
                    event = {"id": event_id, "type": event_type,
                             "data": json.loads("\n".join(data_lines) or "{}")}
                    events.append(event)
                    if event_type == target:
                        return events
                    event_type, data_lines = None, []
    raise AssertionError(f"SSE 未收到 {target}：{events}")


async def run_flow(client: httpx.AsyncClient, order: dict, action: str) -> dict:
    """端到端验证一次改签或退票；覆盖报价前无副作用、确认履约和事件顺序。"""
    order_id = order["order_id"]
    before = await order_snapshot(client, order_id)
    if action == "CHANGE":
        target_date = max(date.today(), date.fromisoformat(order["date"])) + timedelta(days=1)
        message = f"订单 {order_id} 改签到 {target_date.isoformat()}"
        final_status = "CHANGED"
    else:
        message = f"订单 {order_id} 退票"
        final_status = "REFUNDED"

    created = check(await client.post("/cases", json={"message": message, "order_id": order_id}), 202)
    assert created["case_id"] and created["task_id"]
    case_id = created["case_id"]
    proposed_events_task = asyncio.create_task(read_events_until(client, case_id, "case.proposed"))
    case, quote = await wait_for_quote(client, case_id, action)
    proposed_events = await proposed_events_task
    assert case["status"] in {"WAITING_CONFIRMATION", "PROPOSED"}
    assert await order_snapshot(client, order_id) == before, "确认前订单发生变化"

    confirmation_id = f"smoke-confirm-{uuid.uuid4().hex}"
    idempotency_key = f"smoke-idempotency-{uuid.uuid4().hex}"
    confirmed = check(await client.post(f"/quotes/{quote['quote_id']}/confirm", json={
        "confirmation_id": confirmation_id,
        "idempotency_key": idempotency_key,
    }), 202)
    assert confirmed["operation_id"]
    completed_events_task = asyncio.create_task(read_events_until(
        client, case_id, "fulfillment.completed", after=proposed_events[-1]["id"]))
    completed = await wait_for_completion(client, case_id, order_id, final_status)
    completed_events = await completed_events_task
    events = proposed_events + completed_events
    event_types = [event["type"] for event in events]
    for required in ("case.started", "case.trace", "quote.offered", "case.proposed", "fulfillment.completed"):
        assert required in event_types, f"缺少事件 {required}：{event_types}"
    assert event_types.index("case.started") < event_types.index("quote.offered") < event_types.index("case.proposed")
    assert event_types[-1] == "fulfillment.completed", event_types

    details = quote["details"][0]
    return {
        "action": action,
        "case_id": case_id,
        "task_id": created["task_id"],
        "quote_id": quote["quote_id"],
        "amount": quote["amount"],
        "fee_items": details["fee_items"],
        "rule_refs": details["rule_refs"],
        "before": before,
        "operation_id": confirmed["operation_id"],
        "after": completed["order"],
        "trace_events": event_types.count("case.trace"),
        "events": [event_type for event_type in event_types if event_type != "case.trace"],
    }


async def main(base_url: str) -> None:
    """运行零密钥改签与退票冒烟；先重置演示数据，再输出两条完整交易证据。"""
    async with httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(30, read=90), trust_env=False) as client:
        health = check(await client.get("/health"))
        assert health["status"] == "ok"
        client.headers["Authorization"] = "Bearer demo:u_zhang"
        check(await client.post("/orders", json={"action": "reset_demo_data"},
                                headers={"Authorization": "Bearer demo-admin:u_zhang"}))
        inventory = check(await client.get("/orders"))["orders"]
        change_order = next(order for order in inventory
                            if order["status"] == "ISSUED" and order["eligibility"]["change"]["allowed"])
        refund_order = next(order for order in inventory
                            if order["order_id"] != change_order["order_id"] and order["status"] == "ISSUED"
                            and order["eligibility"]["refund"]["allowed"])
        change = await run_flow(client, change_order, "CHANGE")
        refund = await run_flow(client, refund_order, "REFUND")
        print(json.dumps({"health": health, "change": change, "refund": refund}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8123/api/v1")
    args = parser.parse_args()
    asyncio.run(main(args.base_url.rstrip("/")))
