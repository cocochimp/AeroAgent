"""Native ESM assets for the DSH workbench are served by the existing backend."""
from fastapi.testclient import TestClient

from app.api.main import app


def test_dsh_ui_serves_native_module_and_stylesheet():
    client = TestClient(app)
    module = client.get("/dsh-ui/main.js")
    styles = client.get("/dsh-ui/styles.css")
    assert module.status_code == 200
    assert module.headers["content-type"].startswith("text/javascript")
    assert "mountAeroAgent" in module.text
    assert styles.status_code == 200
    assert "text/css" in styles.headers["content-type"]


def test_dsh_ui_does_not_expose_files_outside_its_asset_root():
    response = TestClient(app).get("/dsh-ui/../client.js")
    assert response.status_code in {400, 404}
