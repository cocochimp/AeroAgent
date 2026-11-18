import subprocess
import sys


def test_backend_api_imports_without_agent_service_cycle():
    completed = subprocess.run(
        [sys.executable, "-c", "from app.api.main import app; print(app.title)"],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert "机票退改签工作台 API" in completed.stdout


def test_versioned_api_has_at_most_sixteen_operations():
    completed = subprocess.run(
        [sys.executable, "-c", "from app.adapters.inbound.http import admin,cases,orders,health; routers=(admin.router,cases.router,orders.router,health.router); print(sum(1 for router in routers for route in router.routes if route.path.startswith('/api/v1') for method in route.methods if method not in {'HEAD','OPTIONS'}))"],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    assert int(completed.stdout.strip()) == 16


def test_desktop_python_entry_is_covered_by_docstring_gate():
    from desktop import backend_entry
    from scripts import check_docstrings

    assert "desktop" in check_docstrings.TARGETS
    assert backend_entry.main.__doc__
