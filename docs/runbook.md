# AeroAgent 运行与运维手册

## lite 本地启动

先决条件为 uv、Node.js 24+ 与 npm。默认使用 mock 决策和 mock 航司，无需 API Key。

```bash
uv sync
uv run uvicorn app.api.main:app --port 8000
```

另开终端启动工作台：

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
```

访问 <http://localhost:5173>，健康检查为 <http://127.0.0.1:8000/api/v1/health>。FastAPI lifespan 会完成建表、种子数据初始化、检索投影同步，并在同一进程启动 worker；应用关闭时 worker 随之停止。

### 数据与配置位置

- SQLite：`var/aeroagent.db`；LangGraph 检查点与本地运行数据也由 SQLite 承载。
- 运行配置：项目根目录 `config.json`，不存在时使用内置 mock 默认值；可参考 `config.example.json`。
- 本地模型缓存：`models/`。首次启用混合检索时可能需要下载模型，之后由 fastembed 在本地计算向量。
- 可通过 `AIR_VAR_DIR`、`AIR_CONFIG_PATH` 和 `DATABASE_URL` 覆盖数据目录、配置文件和数据库地址。

本地默认自动建表；需要显式执行版本迁移时运行：

```bash
uv run alembic upgrade head
```

lite 仅按单进程、单写者运行，不要增加 uvicorn worker 数量，也不要让多个进程同时写同一个数据库文件。

## Docker 全栈

```bash
./start.sh
```

访问 <http://localhost:8080>。Compose 启动 `aeroagent-api` 与 `aeroagent-web`，将宿主机的 `var/` 挂载到 API 容器。首次启动可直接使用 `.env.example` 的默认值；需要覆盖端口或鉴权配置时复制为 `.env`。

常用命令：

```bash
docker compose --env-file .env.example -f infra/docker-compose.yml ps
docker compose --env-file .env.example -f infra/docker-compose.yml logs -f aeroagent-api aeroagent-web
```

停止前台 Compose 可按 `Ctrl+C`。若自定义了 `.env`，上述命令的 `--env-file` 参数也应改为 `.env`。

## 前端热更新

保持 lite API 在 8000 端口运行，再执行：

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
```

Vite 默认将 `/api` 代理到 `http://127.0.0.1:8000`；桌面开发脚本会通过 `VITE_API_PROXY_TARGET` 指向动态后端端口。仅启动前端不会提供案件、订单、评测或办理能力。

## 桌面版

开发模式同时启动 Vite、Electron 和动态端口上的 FastAPI：

```bash
npm --prefix frontend ci
npm --prefix desktop install
npm --prefix desktop run dev
```

桌面主进程等待健康检查通过后加载页面。退出时先发送 `SIGTERM`，超时后强制清理后端进程树，避免残留进程继续占用数据库和端口。

也可先构建前端，再验证 FastAPI 同源托管页面：

```bash
npm --prefix frontend run build
npm --prefix desktop start
```

生产打包：

```bash
npm --prefix desktop run dist
```

该命令依次构建前端、使用 PyInstaller onedir 构建后端并调用 electron-builder，安装包输出到 `desktop/release/`。

- 开发版数据仍位于项目 `var/aeroagent.db` 与根目录 `config.json`。
- 生产版数据写入 Electron `userData` 下的 `var/aeroagent.db` 和 `config.json`；macOS 通常位于 `~/Library/Application Support/AeroAgent/`。
- 后端与主进程日志写入 Electron 日志目录的 `backend.log`；macOS 通常位于 `~/Library/Logs/AeroAgent/backend.log`。

## 验证与零 key 冒烟

```bash
uv run pytest -q
uv run python scripts/check_docstrings.py
npm --prefix frontend test -- --reporter=dot
npm --prefix frontend run build
```

冒烟脚本要求服务先运行在 8123 端口：

```bash
# 终端一
uv run uvicorn app.api.main:app --port 8123

# 终端二
uv run python scripts/smoke_lite.py
```

脚本会重置虚构数据，分别跑通改签和退票，检查确认前订单不变、报价费用与规则引用、确认后订单状态以及 SSE 事件顺序。成功时输出包含 `health`、`change`、`refund` 的 JSON；断言失败时以非零状态退出。

## 演示数据、配置与观测

管理员工作台的“数据”页可设置航班正常、延误或取消，清理会员画像并重置虚构种子数据。共享 fixtures 位于 `demo_data/`。

“配置”页可读写运行参数并检查可选的 LLM 连通性。默认 `mode=mock`；设置为 `deepseek` 后仅 LLM 决策走真实模型，航司办理仍由适配器完成。API Key 读取时打码，共享环境应改用受控密钥管理，不要提交 `config.json`。

配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后可导出 HTTP、案件和 Agent spans。SSE 支持事件游标续传；Trace 输出经过字段过滤，不应记录凭证。

## 常见故障

| 现象 | 排查与处理 |
|---|---|
| 端口已被占用 | 更换 uvicorn `--port`，并同步设置前端 `VITE_API_PROXY_TARGET`；桌面开发版会自动选择空闲端口。 |
| 冒烟连接失败 | 确认 8123 端口服务已启动，且 `/api/v1/health` 返回 `status=ok` 后再运行脚本。 |
| 首次检索较慢或模型加载失败 | 检查网络与 `models/` 缓存权限；混合检索模型不可用时会保留降级状态，费用仍由确定性引擎计算。 |
| SQLite 锁冲突或数据库只读 | 确保只运行一个写入进程，检查 `var/` 权限和磁盘空间，不要复制正在写入的数据库文件。 |
| 重启后任务未继续 | 进程内队列不持久；先核对案件、操作与订单状态，不要对结果未知的交易盲目重试。 |
| 桌面版启动失败 | 查看 `backend.log`；开发版确认 uv 可用，生产版确认后端可执行文件和前端资源已进入应用 `resources/`。 |
| DeepSeek 调用失败 | 检查 `config.json` 的 base URL、模型、密钥与超时；决策层会记录回退状态，航司办理不受模型供应商配置影响。 |

## 运行边界

lite 的本地向量检索采用线性扫描，进程内队列不做持久化，只适合单实例与中小规模虚构数据。多实例、高并发或共享部署前，需要重新设计持久化任务投递、检索扩展、身份接入、密钥管理与容灾方案。

所有航班、订单和办理结果均为虚构数据，不连接真实航司、GDS 或支付渠道。演示令牌不得用于共享生产环境。
