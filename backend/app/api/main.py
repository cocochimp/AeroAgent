"""FastAPI application assembled from inbound adapters."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


from backend.app.adapters.inbound.http import admin, cases, health, orders
from backend.app.adapters.inbound.http.errors import validation_error_handler
from backend.app.adapters.outbound.postgres.database import SessionFactory, engine, initialize_schema
from backend.app.adapters.outbound.postgres.seed import seed_demo_data
from backend.app.adapters.outbound.legacy.runtime_projection import sync_agent_projection
from backend.app.adapters.outbound.telemetry.tracing import configure_tracing


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_tracing()
    await initialize_schema()
    async with SessionFactory() as session:
        await seed_demo_data(session)
    # Existing deterministic calculation remains behind a read-only SQLite projection.
    async with SessionFactory() as session:
        await sync_agent_projection(session)
    yield
    await engine.dispose()


app = FastAPI(title="机票退改签工作台 API", version="1.0.0", lifespan=lifespan,
             docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def trace_http_requests(request, call_next):
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
app.add_exception_handler(RequestValidationError, validation_error_handler)


@app.exception_handler(HTTPException)
async def http_error_handler(_, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "HTTP_ERROR", "message": str(exc.detail)}
    return JSONResponse(status_code=exc.status_code,
                        content={"error": {"code": detail.get("code", "HTTP_ERROR"),
                                           "message": detail.get("message", "请求失败"),
                                           "details": detail.get("details", {})}})


@app.exception_handler(Exception)
async def unexpected_error_handler(_, exc: Exception):
    return JSONResponse(status_code=500,
                        content={"error": {"code": "INTERNAL", "message": "服务内部错误", "details": {}}})
