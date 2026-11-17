"""稳定的版本化 API 错误信封。"""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    """把请求校验异常转换为统一 422 响应；字段路径去掉框架定位前缀。"""
    fields = {".".join(str(p) for p in error["loc"] if p not in {"body", "query", "path"}): error["msg"]
              for error in exc.errors()}
    return JSONResponse(status_code=422, content={"error": {"code": "VALIDATION", "message": "请求参数不合法", "fields": fields}})


def error_response(status_code: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    """构造统一版本化错误信封；详情缺省时返回空对象以保持结构稳定。"""
    return JSONResponse(status_code=status_code,
                        content={"error": {"code": code, "message": message, "details": details or {}}})
