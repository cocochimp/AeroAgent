import subprocess
import sys


def test_backend_api_imports_without_agent_service_cycle():
    completed = subprocess.run(
        [sys.executable, "-c", "from app.api.main import app; print(app.title)"],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert "AeroAgent API" in completed.stdout


def test_versioned_api_exposes_required_routes():
    """OpenAPI 必须包含插件依赖的核心路由，避免重构时误删。"""
    completed = subprocess.run(
        [sys.executable, "-c",
         "from app.api.main import app; print('\\n'.join(sorted(app.openapi()['paths'])))"],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    paths = set(completed.stdout.splitlines())
    required = {"/api/v1/meta", "/api/v1/orders", "/api/v1/orders/{order_id}",
                "/api/v1/cases", "/api/v1/cases/{case_id}", "/api/v1/cases/{case_id}/messages",
                "/api/v1/cases/{case_id}/cancel", "/api/v1/cases/{case_id}/events",
                "/api/v1/quotes/{quote_id}/confirm", "/api/v1/operations/{operation_id}",
                "/api/v1/operations/{operation_id}/reconcile", "/api/v1/admin/mock",
                "/api/v1/health"}
    assert required <= paths, sorted(required - paths)
