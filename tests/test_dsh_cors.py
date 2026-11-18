"""DSH 浏览器跨域访问契约。"""
from fastapi.testclient import TestClient

from app.api.main import app


def test_local_dsh_preflight_allows_demo_authorization():
    response = TestClient(app).options(
        "/api/v1/orders",
        headers={
            "Origin": "http://127.0.0.1:3080",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3080"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def test_unlisted_origin_does_not_receive_cors_access():
    response = TestClient(app).get(
        "/v1/models", headers={"Origin": "https://untrusted.example"}
    )
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
