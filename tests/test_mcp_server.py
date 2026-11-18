"""app.mcp 只读 MCP server 的自包含测试：内嵌假后端 + asyncio 子进程走 stdio 协议。"""
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

ORDERS_PAYLOAD = {"orders": [{"order_id": "ORD20260926001", "user_id": "u_zhang",
                              "flight_no": "MU5137", "date": "2026-09-28", "status": "PAID"}]}
CASE_PAYLOAD = {"case_id": "case_1", "status": "WAITING_CONFIRMATION",
                "quotes": [{"quote_id": "q_1", "action": "CHANGE", "amount": 320,
                            "currency": "CNY", "status": "OFFERED"}]}
RULES_PAYLOAD = {"rules": [{"id": "rule_mu_change", "airline": "MU", "active": True}]}
RUNS_PAYLOAD = {"view": "runs", "runs": [{"run_id": "run_1", "status": "SUCCEEDED"},
                                          {"run_id": "run_0", "status": "SUCCEEDED"}]}
RUN_PAYLOAD = {"run_id": "run_1", "status": "SUCCEEDED", "report": {"passed": 3, "total": 4}}

EXPECTED_TOOLS = {"aeroagent_list_orders", "aeroagent_get_case", "aeroagent_get_quote",
                  "aeroagent_list_rules", "aeroagent_get_evaluation"}


class FakeBackendHandler(BaseHTTPRequestHandler):
    """按路径返回固定 JSON 的假后端，并记录 Authorization 头供断言。"""

    auth_headers: list[str] = []

    def do_GET(self):  # noqa: N802 - http.server 约定的方法名
        path = self.path.split("?")[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        FakeBackendHandler.auth_headers.append(self.headers.get("Authorization", ""))
        if path == "/api/v1/orders":
            payload = ORDERS_PAYLOAD
        elif path == "/api/v1/cases/case_1":
            payload = CASE_PAYLOAD
        elif path == "/api/v1/admin/rules":
            payload = RULES_PAYLOAD
        elif path == "/api/v1/admin/evaluations":
            payload = RUN_PAYLOAD if "view=run&" in query or query.endswith("view=run") else RUNS_PAYLOAD
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":{"code":"NOT_FOUND","message":"x"}}')
            return
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        """静默访问日志，避免污染 pytest 输出。"""


def start_fake_backend() -> tuple[ThreadingHTTPServer, int]:
    """在随机端口启动假后端线程，返回 server 实例和端口号。"""
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBackendHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


async def spawn_mcp(port: int) -> asyncio.subprocess.Process:
    """以子进程方式启动 `python -m app.mcp`，后端指向假后端端口。"""
    env = {**os.environ, "AEROAGENT_BACKEND_URL": f"http://127.0.0.1:{port}"}
    return await asyncio.create_subprocess_exec(
        sys.executable, "-m", "app.mcp", cwd=str(ROOT), env=env,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE)


async def rpc(proc: asyncio.subprocess.Process, payload: dict) -> dict | None:
    """写入一条 JSON-RPC 消息；通知（无 id）返回 None，请求则等待一行响应。"""
    proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
    await proc.stdin.drain()
    if "id" not in payload:
        return None
    line = await asyncio.wait_for(proc.stdout.readline(), timeout=10)
    assert line, "MCP 子进程提前退出"
    return json.loads(line)


def test_mcp_stdio_full_flow():
    """initialize→tools/list→tools/call 全链路：五个工具可调用，返回含 ORD 单号。"""
    asyncio.run(_full_flow())


async def _full_flow():
    FakeBackendHandler.auth_headers.clear()
    server, port = start_fake_backend()
    proc = await spawn_mcp(port)
    try:
        init = await rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                "params": {"protocolVersion": "2024-11-05", "capabilities": {}}})
        assert init["result"]["protocolVersion"] == "2024-11-05"
        assert init["result"]["serverInfo"]["name"] == "aeroagent-mcp"

        # 通知不产生响应；ping 返回空对象
        await rpc(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        ping = await rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "ping"})
        assert ping["result"] == {}

        listed = await rpc(proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
        tools = listed["result"]["tools"]
        assert {t["name"] for t in tools} == EXPECTED_TOOLS
        assert all("inputSchema" in t and "description" in t for t in tools)

        call = await rpc(proc, {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                "params": {"name": "aeroagent_list_orders", "arguments": {}}})
        result = call["result"]
        assert result["isError"] is False
        text = result["content"][0]["text"]
        assert "ORD20260926001" in text
        assert "MU5137" in text

        case = await rpc(proc, {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                                "params": {"name": "aeroagent_get_case",
                                           "arguments": {"case_id": "case_1"}}})
        assert "WAITING_CONFIRMATION" in case["result"]["content"][0]["text"]

        quote = await rpc(proc, {"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                                 "params": {"name": "aeroagent_get_quote",
                                            "arguments": {"quote_id": "q_1", "case_id": "case_1"}}})
        quote_text = quote["result"]["content"][0]["text"]
        assert quote["result"]["isError"] is False
        assert '"amount": 320' in quote_text

        rules = await rpc(proc, {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                                 "params": {"name": "aeroagent_list_rules", "arguments": {}}})
        assert "rule_mu_change" in rules["result"]["content"][0]["text"]

        evaluation = await rpc(proc, {"jsonrpc": "2.0", "id": 8, "method": "tools/call",
                                      "params": {"name": "aeroagent_get_evaluation", "arguments": {}}})
        evaluation_text = evaluation["result"]["content"][0]["text"]
        assert "run_1" in evaluation_text and '"passed": 3' in evaluation_text

        # 用户接口用 demo: 令牌，管理员接口用 demo-admin: 令牌
        assert "Bearer demo:u_zhang" in FakeBackendHandler.auth_headers
        assert "Bearer demo-admin:u_zhang" in FakeBackendHandler.auth_headers
    finally:
        proc.stdin.close()
        await asyncio.wait_for(proc.wait(), timeout=10)
        server.shutdown()


def test_mcp_protocol_and_tool_errors():
    """未知方法回 -32601，未知工具回 -32602，工具内错误走 isError 结果。"""
    asyncio.run(_error_flow())


async def _error_flow():
    server, port = start_fake_backend()
    proc = await spawn_mcp(port)
    try:
        unknown_method = await rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "resources/list"})
        assert unknown_method["error"]["code"] == -32601

        unknown_tool = await rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                        "params": {"name": "nope", "arguments": {}}})
        assert unknown_tool["error"]["code"] == -32602

        missing_arg = await rpc(proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                       "params": {"name": "aeroagent_get_case", "arguments": {}}})
        assert missing_arg["result"]["isError"] is True
        assert "case_id" in missing_arg["result"]["content"][0]["text"]

        backend_404 = await rpc(proc, {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                                       "params": {"name": "aeroagent_get_case",
                                                  "arguments": {"case_id": "case_missing"}}})
        assert backend_404["result"]["isError"] is True
        assert "404" in backend_404["result"]["content"][0]["text"]
    finally:
        proc.stdin.close()
        await asyncio.wait_for(proc.wait(), timeout=10)
        server.shutdown()
