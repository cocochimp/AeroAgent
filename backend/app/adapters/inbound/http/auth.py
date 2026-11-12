"""Verified principal extraction; plaintext demo tokens work only in demo mode."""
import os
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from backend.app.adapters.outbound.postgres.database import SessionFactory
from backend.app.adapters.outbound.postgres.models import ProfileRecord


bearer = HTTPBearer(auto_error=False)
APP_ENV = os.getenv("APP_ENV", "development").lower()
DEMO_AUTH = os.getenv("DEMO_AUTH", "true" if APP_ENV in {"development", "demo", "local"} else "false").lower() == "true"


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: str
    roles: frozenset[str]
    demo: bool = False

    @property
    def is_admin(self) -> bool:
        return "admin" in self.roles


async def get_principal(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> Principal:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "需要登录")
    token = credentials.credentials
    principal: Principal
    if DEMO_AUTH and token.startswith("demo:"):
        user_id = token.removeprefix("demo:").strip()
        principal = Principal(user_id=user_id, roles=frozenset({"user"}), demo=True)
    elif DEMO_AUTH and token.startswith("demo-admin:"):
        user_id = token.removeprefix("demo-admin:").strip()
        principal = Principal(user_id=user_id, roles=frozenset({"user", "admin"}), demo=True)
    else:
        secret = os.getenv("JWT_SECRET")
        if not secret:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "服务端未配置身份验证")
        try:
            claims = jwt.decode(token, secret, algorithms=["HS256"], options={"require": ["sub", "exp"]})
        except jwt.PyJWTError as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录凭证无效") from exc
        user_id = str(claims.get("sub", ""))
        principal = Principal(user_id=user_id, roles=frozenset(claims.get("roles", [])))
    if not principal.user_id or len(principal.user_id) > 64:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录凭证无效")
    async with SessionFactory() as session:
        exists = await session.scalar(select(ProfileRecord.user_id).where(ProfileRecord.user_id == principal.user_id))
    if not exists:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "登录用户不存在")
    return principal


async def require_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "需要管理员权限")
    return principal
