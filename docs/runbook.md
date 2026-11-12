# 本地运行与运维

## 完整学习环境

1. 安装 Docker Desktop；首次启动复制 `.env.example` 为 `.env`。本地学习保留 `DEMO_AUTH=true`。
2. 执行 `./start.sh`，等待容器健康检查通过。
3. 打开 <http://localhost:8080>。健康检查：<http://localhost:8080/api/v1/health>。

Compose 启动 React/Nginx、FastAPI、后台 worker、PostgreSQL、Redis 和 Qdrant。React 仅请求 FastAPI；PostgreSQL 是业务数据事实源，Redis 承载队列与实时事件，Agent 与模拟航司 adapter 执行规则模式办理。

停止服务：`Ctrl+C`。查看状态：`docker compose --env-file .env -f infra/docker-compose.yml ps`。查看日志：

```bash
docker compose --env-file .env -f infra/docker-compose.yml logs -f api worker web
```

## 前端热更新

保持 Docker 中 PostgreSQL、Redis、Qdrant、API 和 worker 运行，然后另开终端：

```bash
cd frontend
npm ci
npm run dev
```

打开 <http://localhost:5173>；Vite 将 `/api` 代理到 `http://127.0.0.1:8000`。单独运行前端不能展示服务端订单、真实 Agent 流程或评测结果。

需要单独调试后端时，可在依赖服务运行后启动：

```bash
uv sync
uv run uvicorn backend.app.api.main:app --reload --port 8000
```

环境变量和数据库地址按 `.env.example` 与 `infra/docker-compose.yml` 配置。生产部署关闭 `AUTO_CREATE_SCHEMA`，先运行 `uv run alembic upgrade head`。

## 测试与 CLI

```bash
uv run pytest -q
npm --prefix frontend test -- --reporter=dot
npm --prefix frontend run build
```

旧 Agent CLI 仍可用：`./start.sh --cli --user u_zhang`。CLI 和根 `app.py` 是兼容学习入口；Web 工作台使用 `backend.app.api.main`。

## 演示数据与管理

管理员工作台的“数据”页可设置航班正常/延误/取消、清理会员画像、重置虚构种子数据。重置保留评测历史与审计记录。共享 fixtures 位于 `demo_data/`；每次 Agent 运行前会将 PostgreSQL 当前业务数据同步到兼容适配层。

“配置”页可读写运行参数并可选检查 LLM 连通性。API Key 在读取时打码；演示环境配置持久化于 `var/config.json`。共享部署应改用密钥管理服务。

## 观测与故障处理

- 配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后导出 HTTP、案件和 Agent spans；事件流保留案件 Trace 输入/输出 allowlist，并过滤消息正文和凭证。
- Redis 暂时不可用时，案件事件仍写入数据库；Outbox 保留待投递消息，dispatcher 恢复后重试。
- Qdrant/检索模型不可用时，检索兼容层会按当前配置降级；费用仍由确定性规则引擎计算。
- worker 失败时检查案件/运行状态与容器日志；交易状态未知时按 operation ID 和幂等键核对，不要盲目重放。

## 当前边界

客票和航司办理均为虚构数据与 mock adapter。共享环境上线前仍需接企业身份源、密钥管理、真实航司/GDS adapter、账务对账和财务金标准评测。
