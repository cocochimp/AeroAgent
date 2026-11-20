"""前端启动所需的只读元信息。"""
from fastapi import APIRouter, Depends
from sqlalchemy import select

from app import config
from app.adapters.inbound.http.auth import Principal, get_principal
from app.adapters.outbound.persistence.database import SessionFactory
from app.adapters.outbound.persistence.models import ProfileRecord

router = APIRouter(prefix="/api/v1", tags=["meta"])


@router.get("/meta")
async def get_meta(principal: Principal = Depends(get_principal)):
    """返回版本、演示用户、航司模式与功能开关；不包含任何密钥。"""
    async with SessionFactory() as session:
        profiles = list(await session.scalars(select(ProfileRecord).order_by(ProfileRecord.user_id)))
    cfg = config.get()
    return {"version": "1.0.0", "user_id": principal.user_id, "is_admin": principal.is_admin,
            "users": [{"user_id": row.user_id, "name": row.name, "tier": row.tier} for row in profiles],
            "airline": {"mode": cfg["airline"]["mode"], "scenario": cfg["airline"]["scenario"]},
            "features": {"servicing": True, "booking": True, "watches": True,
                         "evaluation": True, "mock_console": True}}
