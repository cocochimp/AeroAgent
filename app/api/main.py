"""组装 FastAPI 入站适配器，并管理应用生命周期与统一异常响应。"""
import asyncio
import os
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException


from app.adapters.inbound.http import admin, cases, health, openai_compat, orders
from app.adapters.inbound.http.errors import validation_error_handler
from app.adapters.outbound.postgres.database import SessionFactory, engine, initialize_schema
from app.adapters.outbound.postgres.seed import seed_demo_data
from app.adapters.outbound.sqlite.runtime_projection import sync_agent_projection
from app.adapters.outbound.telemetry.tracing import configure_tracing
from app.worker import run_worker


@asynccontextmanager
async def lifespan(_: FastAPI):
    """初始化数据库、检索投影和后台 worker；关闭时先停 worker 再释放数据库连接。"""
    configure_tracing()
    await initialize_schema()
    async with SessionFactory() as session:
        await seed_demo_data(session)
    # 既有确定性计算只读取 SQLite 投影，不直接接触 Agent 推理状态。
    async with SessionFactory() as session:
        await sync_agent_projection(session)
    worker_task = asyncio.create_task(run_worker())
    try:
        yield
    finally:
        # 先等待 worker 退出并关闭流，再释放数据库，避免退出期仍访问连接池。
        worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await worker_task
        await engine.dispose()


app = FastAPI(title="机票退改签工作台 API", version="1.0.0", lifespan=lifespan,
             docs_url=None, redoc_url=None, openapi_url=None)

# DSH 浏览器插件与本机 API 分属不同端口，只放行显式配置的本机宿主来源。
_DSH_ORIGINS = [origin.strip() for origin in os.getenv(
    "AEROAGENT_DSH_ORIGINS", "http://127.0.0.1:3080,http://localhost:3080").split(",")
                if origin.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_DSH_ORIGINS, allow_credentials=False,
                   allow_methods=["GET", "POST", "PUT", "OPTIONS"],
                   allow_headers=["Authorization", "Content-Type", "Last-Event-ID"])


@app.middleware("http")
async def trace_http_requests(request, call_next):
    """为每次 HTTP 调用补充链路跨度；状态码在下游响应返回后统一记录。"""
    from opentelemetry import trace
    tracer = trace.get_tracer("air-ticket.http")
    with tracer.start_as_current_span("http.request") as span:
        span.set_attribute("http.request.method", request.method)
        span.set_attribute("http.route", request.url.path.split("?")[0])
        response = await call_next(request)
        span.set_attribute("http.response.status_code", response.status_code)
        return response
app.include_router(cases.router)
app.include_router(orders.router)
app.include_router(admin.router)
app.include_router(health.router)
app.include_router(openai_compat.router)

# DSH 的原生 ES 模块由同一后端托管；只读插件目录，不回退到 React 页面。
dsh_ui_dir = Path(__file__).resolve().parents[2] / "dsh-plugin-aeroagent" / "web"
app.mount("/dsh-ui", StaticFiles(directory=str(dsh_ui_dir)), name="dsh-ui")

app.add_exception_handler(RequestValidationError, validation_error_handler)


@app.exception_handler(HTTPException)
async def http_error_handler(_, exc: HTTPException):
    """把 HTTP 异常转换为统一错误响应；保留业务错误码和结构化详情。"""
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code,
                        content={"error": {"code": detail.get("code", "HTTP_ERROR"),
                                           "message": detail.get("message", "请求失败"),
                                           "details": detail.get("details", {})}})


@app.exception_handler(Exception)
async def unexpected_error_handler(_, exc: Exception):
    """兜底未捕获异常并隐藏内部细节；客户端只收到稳定的 500 错误结构。"""
    return JSONResponse(status_code=500,
                        content={"error": {"code": "INTERNAL", "message": "服务内部错误", "details": {}}})


class SPAStaticFiles(StaticFiles):
    """托管单页应用静态资源；API 404 不回退页面，前端路径才交给 React Router。"""
    async def get_response(self, path: str, scope):
        """返回静态文件或前端入口；只捕获非 API 路径的 404。"""
        # 未匹配的 API 仍返回 404，不能回退成前端页面。
        if scope.get("path", path).lstrip("/").startswith("api/"):
            raise StarletteHTTPException(status_code=404)
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404:
                raise
            # 非 API 的未知路径交给 React Router。
            return await super().get_response("index.html", scope)


web_dist = os.getenv("AEROAGENT_WEB_DIST")
if web_dist:
    # 放在所有 API 路由之后，由 FastAPI 同源托管桌面版页面。
    app.mount("/", SPAStaticFiles(directory=str(Path(web_dist).expanduser().resolve()), html=True), name="frontend")
