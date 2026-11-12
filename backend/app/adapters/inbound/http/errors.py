"""Stable versioned API error envelope."""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    fields = {".".join(str(p) for p in error["loc"] if p not in {"body", "query", "path"}): error["msg"]
              for error in exc.errors()}
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION", "message": "请求参数不合法", "fields": fields}})


def error_response(status_code: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=status_code,
                        content={"error": {"code": code, "message": message, "details": details or {}}})
