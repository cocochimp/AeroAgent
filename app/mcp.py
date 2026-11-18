"""只读 MCP server：纯标准库实现 JSON-RPC over stdio，向 DSH 等宿主暴露 AeroAgent 查询工具。

入口：``python -m app.mcp``。零第三方依赖，工具数据全部通过 HTTP 调本机后端，
后端地址取环境变量 AEROAGENT_BACKEND_URL（默认 http://127.0.0.1:8000）。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "aeroagent-mcp", "version": "0.1.0"}
DEFAULT_BACKEND_URL = "http://127.0.0.1:8000"
DEFAULT_USER_ID = "u_zhang"
HTTP_TIMEOUT = 15


def backend_url() -> str:
    """读取后端 base url；未配置环境变量时回落到本机 8000 端口。"""
    return os.getenv("AEROAGENT_BACKEND_URL", DEFAULT_BACKEND_URL).rstrip("/")


def http_get(path: str, user_id: str | None = None, admin: bool = False) -> dict:
    """向后端发起带演示 Bearer 令牌的 GET 请求并解析 JSON。

    普通接口用 ``demo:{user_id}``，管理员接口用 ``demo-admin:{user_id}``
    （rules/evaluations 路由要求 admin 角色，见 app/adapters/inbound/http/auth.py）。
    """
    actor = user_id or DEFAULT_USER_ID
    token = f"demo-admin:{actor}" if admin else f"demo:{actor}"
    request = urllib.request.Request(f"{backend_url()}{path}",
                                     headers={"Authorization": f"Bearer {token}",
                                              "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"后端返回 {exc.code}：{body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"无法连接后端 {backend_url()}：{exc.reason}") from exc


def tool_list_orders(arguments: dict) -> dict:
    """查询乘客订单列表（GET /api/v1/orders）；user_id 缺省时用演示用户 u_zhang。"""
    return http_get("/api/v1/orders", arguments.get("user_id"))


def tool_get_case(arguments: dict) -> dict:
    """查询单个服务案件详情（GET /api/v1/cases/{case_id}），含状态、结果与报价列表。"""
    case_id = _require(arguments, "case_id")
    quoted = urllib.parse.quote(case_id, safe="")
    return http_get(f"/api/v1/cases/{quoted}", arguments.get("user_id"))


def tool_get_quote(arguments: dict) -> dict:
    """按 quote_id 读取报价。

    后端没有独立的 quote 查询接口，本工具从案件详情（GET /api/v1/cases/{case_id}）
    的 quotes 列表中筛选匹配项，因此必须同时提供 case_id。
    """
    quote_id = _require(arguments, "quote_id")
    case_id = _require(arguments, "case_id")
    case = tool_get_case({"case_id": case_id, "user_id": arguments.get("user_id")})
    for quote in case.get("quotes", []):
        if quote.get("quote_id") == quote_id:
            return {"quote": quote, "case_id": case_id, "case_status": case.get("status")}
    raise RuntimeError(f"案件 {case_id} 中不存在报价 {quote_id}")


def tool_list_rules(arguments: dict) -> dict:
    """查询当前生效的退改政策规则（GET /api/v1/admin/rules，需管理员演示令牌）。"""
    return http_get("/api/v1/admin/rules", arguments.get("user_id"), admin=True)


def tool_get_evaluation(arguments: dict) -> dict:
    """读取最新一次评测运行（GET /api/v1/admin/evaluations）。

    先用 view=runs 拿到按创建时间倒序的运行列表，取第一条 run_id，
    再用 view=run&run_id=... 返回该次运行的进度与报告。
    """
    runs = http_get("/api/v1/admin/evaluations?view=runs", arguments.get("user_id"), admin=True)
    items = runs.get("runs", [])
    if not items:
        return {"run": None, "message": "暂无评测运行"}
    run_id = items[0]["run_id"]
    detail = http_get(f"/api/v1/admin/evaluations?view=run&run_id={urllib.parse.quote(run_id, safe='')}",
                      arguments.get("user_id"), admin=True)
    return {"run": detail, "latest_of": len(items)}


def _require(arguments: dict, key: str) -> str:
    value = arguments.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"缺少必填参数 {key}")
    return value.strip()


TOOLS = [
    {"name": "aeroagent_list_orders",
     "description": "列出乘客的机票订单及退改试算资格（演示数据，只读）。",
     "handler": tool_list_orders,
     "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
         "user_id": {"type": "string", "description": "乘客 ID，如 u_zhang；缺省为 u_zhang"}}}},
    {"name": "aeroagent_get_case",
     "description": "读取单个退改服务案件的状态、结果和报价列表（只读）。",
     "handler": tool_get_case,
     "inputSchema": {"type": "object", "additionalProperties": False,
                     "required": ["case_id"], "properties": {
                         "case_id": {"type": "string", "description": "案件 ID，如 case_xxx"},
                         "user_id": {"type": "string", "description": "案件归属乘客 ID；缺省为 u_zhang"}}}},
    {"name": "aeroagent_get_quote",
     "description": "按 quote_id 读取报价详情；后端无独立报价接口，数据取自案件详情的 quotes，需同时提供 case_id。",
     "handler": tool_get_quote,
     "inputSchema": {"type": "object", "additionalProperties": False,
                     "required": ["quote_id", "case_id"], "properties": {
                         "quote_id": {"type": "string", "description": "报价 ID"},
                         "case_id": {"type": "string", "description": "报价所属案件 ID"},
                         "user_id": {"type": "string", "description": "案件归属乘客 ID；缺省为 u_zhang"}}}},
    {"name": "aeroagent_list_rules",
     "description": "列出当前加载的退改政策规则（管理员只读视图）。",
     "handler": tool_list_rules,
     "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
         "user_id": {"type": "string", "description": "演示管理员 ID；缺省为 u_zhang"}}}},
    {"name": "aeroagent_get_evaluation",
     "description": "读取最新一次评测运行的进度与报告（管理员只读视图）。",
     "handler": tool_get_evaluation,
     "inputSchema": {"type": "object", "additionalProperties": False, "properties": {
         "user_id": {"type": "string", "description": "演示管理员 ID；缺省为 u_zhang"}}}},
]

_TOOL_MAP = {tool["name"]: tool for tool in TOOLS}


def handle_initialize() -> dict:
    """返回协议版本、能力声明和 server 信息；本 server 只声明 tools 能力。"""
    return {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {}},
            "serverInfo": SERVER_INFO}


def handle_tools_list() -> dict:
    """返回全部只读工具的元数据；剥掉内部 handler 字段后即为 MCP tools 列表。"""
    return {"tools": [{key: value for key, value in tool.items() if key != "handler"}
                      for tool in TOOLS]}


def handle_tools_call(params: dict) -> dict:
    """执行一次工具调用；业务/后端错误按 MCP 约定放进 isError 结果而非协议错误。"""
    name = params.get("name", "")
    tool = _TOOL_MAP.get(name)
    if tool is None:
        raise KeyError(name)
    arguments = params.get("arguments") or {}
    try:
        payload = tool["handler"](arguments if isinstance(arguments, dict) else {})
        text = json.dumps(payload, ensure_ascii=False, default=str)
        return {"content": [{"type": "text", "text": text}], "isError": False}
    except Exception as exc:  # noqa: BLE001 - 工具错误统一回传宿主，不中断 stdio 循环
        return {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}],
                "isError": True}


def handle_ping() -> dict:
    """响应宿主心跳；MCP ping 固定返回空结果对象。"""
    return {}


def _error(request_id, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def dispatch(message: dict) -> dict | None:
    """分发单条 JSON-RPC 消息；通知（无 id）一律不产生响应。"""
    request_id = message.get("id")
    method = message.get("method", "")
    params = message.get("params") or {}
    is_request = request_id is not None
    try:
        if method == "initialize":
            result = handle_initialize()
        elif method == "ping":
            result = handle_ping()
        elif method == "tools/list":
            result = handle_tools_list()
        elif method == "tools/call":
            result = handle_tools_call(params)
        elif method in {"notifications/initialized", "initialized"}:
            return None
        elif is_request:
            return _error(request_id, -32601, f"不支持的方法：{method}")
        else:
            return None  # 未知通知直接忽略
    except KeyError as exc:
        if not is_request:
            return None
        return _error(request_id, -32602, f"未知工具：{exc.args[0] if exc.args else ''}")
    except Exception as exc:  # noqa: BLE001 - 协议层兜底，保证 stdio 循环不崩
        if not is_request:
            return None
        return _error(request_id, -32603, f"{type(exc).__name__}: {exc}")
    if not is_request:
        return None
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def main() -> int:
    """stdio 主循环：按行读 JSON-RPC 消息、分发并回写；stdin 关闭即退出。"""
    stdin = sys.stdin
    stdout = sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            response = _error(None, -32700, "JSON 解析失败")
        else:
            response = dispatch(message if isinstance(message, dict) else {})
        if response is not None:
            stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
