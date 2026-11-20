# 运行手册

## 本地启动

```bash
uv sync
uv run uvicorn app.api.main:app --host 127.0.0.1 --port 8000
```

健康检查：

```bash
curl -fsS http://127.0.0.1:8000/api/v1/health
```

首次启动会在 `var/` 下建库、写演示数据、同步只读投影，并在同一进程启动 worker。

## DSH 插件

```bash
dsh plugin --profile web add /absolute/path/AeroAgent/plugin
```

插件配置见 `docs/dsh-plugin.md`。浏览器不直连后端，所有请求走 `/api/aeroagent/rpc`。

## Docker

```bash
./start.sh
# 或
docker compose up --build
```

默认映射 `8000:8000`（`API_PORT` 可改）；数据挂载在 `var/`。容器只跑后端，DSH 插件在 Web profile 安装。

## 配置

- `config.json`：从 `config.example.json` 复制，保存相对默认值的覆盖项。
- `AIR_VAR_DIR`：数据目录，默认 `var/`。
- `AIR_CONFIG_PATH`：配置文件路径，默认 `config.json`。
- `DEMO_AUTH`：本地演示令牌开关；生产必须关闭并接企业身份源。
- `DATABASE_URL`、`JWT_SECRET`、`APP_ENV`：容器与鉴权相关；生产必须显式设置强 `JWT_SECRET`。
- `AIR_NOW`：固定业务时钟，用于评测/演示边界。

## 常见故障

| 现象 | 处理 |
|---|---|
| 插件显示“无法连接 AeroAgent 网关” | 确认后端 8000 端口与 `backendUrl` 配置 |
| 401/403 | 检查 `identityMode` 与演示令牌；生产检查 JWT |
| 案件一直 PROCESSING | 查看后端日志与 worker；`/api/v1/health` 是否 503 |
| 报价确认返回 409 `REQUOTE_REQUIRED` | 价格变化，按新报价再次确认 |
| `RESULT_UNKNOWN` | 不自动重试；调用 `operations/{id}/reconcile` 或 UI 对账 |
| 航司拒绝 | 案件转人工；查看航司回执中的 `code/message` |
| 演示数据被改乱 | 管理接口 `POST /api/v1/orders` 的 `reset_demo_data`，或删除 `var/` 重启 |

## 验证

```bash
UV_CACHE_DIR=./.uv-cache uv run pytest -q
uv run python scripts/check_docstrings.py
npm --prefix plugin test
node --check plugin/client.js
```

零 key 冒烟：

```bash
uv run uvicorn app.api.main:app --port 8123
uv run python scripts/smoke_lite.py
```

## 数据与边界

- 单进程、单写者、进程内队列；重启会丢失未执行任务。
- `var/aeroagent.db` 业务库、`var/air.db` 只读投影、`var/checkpoints.db` 会话检查点。
- 演示令牌、mock 航司、演示数据不得用于生产。
