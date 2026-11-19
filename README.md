# AeroAgent

AeroAgent 是面向机票退改签场景的垂直 Agent：以 LangGraph 编排三类 Agent，结合混合检索与可插拔的 mock/DeepSeek 决策，并提供零外部服务依赖的 lite 本地运行模式。

所有航班、订单与办理结果均为虚构数据；系统不连接真实航司、GDS 或支付渠道。

## 架构总览

<img width="4536" height="3224" alt="agent (1)" src="https://github.com/user-attachments/assets/5f58f61a-890b-4012-9c46-1fe54d7f2c2c" />

## 核心亮点

- **三 Agent 职责隔离**：主服务 Agent 负责理解与编排，方案 Agent 仅使用只读工具生成方案，交易 Agent 只在确认后办理。
- **可恢复编排与人工介入**：LangGraph 检查点支持追问、确认中断与恢复，关键节点保留 Trace。
- **混合检索**：BGE 向量与 BM25 双路召回，经 RRF 融合、硬过滤、精排和 MMR 去冗余后注入上下文。
- **可靠交易边界**：确认后重新核价，提供价格保护、确认 ID、幂等键与审计记录，避免重复办理。
- **零 key 同通道运行**：mock 与 DeepSeek 实现同一决策接口，默认无需密钥即可跑通完整退改链路。
- **lite 本地运行**：SQLite、进程内队列和本地向量检索随单进程启动，无需额外中间件。

<img width="1325" height="793" alt="cb1fbd96a6119eeb45a9353fcc206e15" src="https://github.com/user-attachments/assets/4569b87b-1c05-4add-a1a8-2ca6e36df139" />


## 技术栈

| 层次 | 技术 | 用途 |
|---|---|---|
| 后端 | Python 3.13、FastAPI、Uvicorn | REST、SSE、应用生命周期与本地服务 |
| Agent | LangGraph、SQLite Checkpoint | 状态编排、中断恢复与人工确认 |
| 决策 | DecisionEngine、mock、DeepSeek | 可插拔的意图与工具决策 |
| 检索 | fastembed BGE、BM25、RRF、FlashRank | 本地向量召回、融合、精排与规则注入 |
| 数据 | SQLite、SQLAlchemy、Alembic | 业务持久化、检查点与 schema 迁移 |
| 前端 | React 18、TypeScript、Vite、Vitest | Agent 开发工作台与交互测试 |
| 桌面 | Electron、PyInstaller、electron-builder | 本地桌面壳、后端打包与安装包构建 |
| 交付 | uv、npm、Docker Compose、GitHub Actions | 依赖管理、全栈启动与持续验证 |

## 目录结构

| 路径 | 说明 |
|---|---|
| `app/` | 唯一后端，包含 API、应用服务、三 Agent、领域逻辑与适配器 |
| `frontend/` | React + Vite 工作台及前端测试 |
| `desktop/` | Electron 主进程、开发联动与生产打包脚本 |
| `dsh-plugin-aeroagent/` | DSH 只读业务工具与零依赖可视化客户端插件 |
| `migrations/` | Alembic 数据库版本迁移 |
| `demo_data/` | 虚构航班、订单、规则与评测种子数据 |
| `eval/` | 评测数据与离线评测资产 |
| `tests/` | 后端单元、集成与 lite 运行测试 |
| `infra/` | Docker Compose 全栈编排 |
| `docs/` | API 说明与运行运维手册 |
| `scripts/` | 零 key 冒烟、演示与代码质量门禁脚本 |

## 快速启动

先决条件：[uv](https://docs.astral.sh/uv/)、Node.js 24+ 与 npm。后端依赖由 uv 按 `pyproject.toml` 和 `uv.lock` 安装。

### lite 本地运行

启动后端：

```bash
uv sync
uv run uvicorn app.api.main:app --port 8000
```

另开终端启动前端：

```bash
npm --prefix frontend ci && npm --prefix frontend run dev
```

访问 <http://localhost:5173>，Vite 将 `/api` 代理到 `http://127.0.0.1:8000`。FastAPI lifespan 会初始化 SQLite、种子数据、本地检索投影和内嵌 worker。

### DSH 可视化接入

学员也可以只在 DSH 宿主内完成完整退改签，不再打开独立网页：

- 左上为查询订单、改签报价、退票报价等业务入口，左下为评测、规则、数据学习入口。
- 对话上方横排订单卡用于关联订单；报价在对话中生成可交互卡片，明确确认后才进入交易。
- 右侧固定展示「流程、检索、记忆、校验」，数据来自同一案件的真实执行结果。
- 确认后的 `202 ACCEPTED` 仅表示受理，客户端会继续跟踪 TransactionAgent，直到 `CHANGED`、`REFUNDED` 或异常终态。

后端仍以 `DEMO_AUTH=true uv run uvicorn app.api.main:app --port 8000` 单独启动，默认 `aeroagent-mock` 不需要 DeepSeek 账号或 API Key。安装、web profile 配置和验收步骤见 [`docs/dsh-integration.md`](docs/dsh-integration.md)，插件说明见 [`dsh-plugin-aeroagent/README.md`](dsh-plugin-aeroagent/README.md)。

### Docker 全栈

安装 Docker Desktop 后执行：

```bash
./start.sh
```

访问 <http://localhost:8080>。Compose 构建并启动前端与 lite 后端，业务数据挂载在 `var/`。

## 默认 mock 与真实 DeepSeek

默认 `mode=mock`，不需要 API Key。复制 `config.example.json` 为项目根目录的 `config.json`，再设置 `mode=deepseek` 与 `llm.api_key` 即可切换真实模型：

```json
{
  "mode": "deepseek",
  "llm": {
    "base_url": "https://api.deepseek.com",
    "api_key": "sk-...",
    "model": "deepseek-chat",
    "timeout": 30
  }
}
```

这些配置只影响 LLM 决策；规则检索与费用计算仍由本地确定性链路完成。航司办理始终通过适配器执行，默认使用 mock，不会因启用 DeepSeek 而连接真实航司。也可在管理员“配置”工作区修改运行参数，密钥读取时仅返回掩码。

## 一次改签的调用链

1. React 调用 `POST /api/v1/cases`，FastAPI 完成鉴权、创建案件并投递进程内任务。
2. FastAPI lifespan 内嵌 worker 消费任务，进入案件应用服务。
3. `MainServiceAgent` 对齐订单、加载记忆并理解改签诉求；信息不足时由 LangGraph 中断并等待补充。
4. `ServicingAdvisorAgent` 依次查询航班状态、检索适用票规，再调用确定性费用引擎计算手续费与差价。
5. 后端保存报价和 Trace，通过 SSE 推送方案；案件等待乘客确认，此阶段订单不变。
6. 乘客确认报价后，应用服务复核价格保护区间，并以确认 ID 和幂等键创建交易操作。
7. `TicketTransactionAgent` 调用 Airline mock 适配器办理，写入订单结果、账本与审计。
8. SSE 推送完成事件，工作台展示办理结果；异常或结果未知时保留现场供核查。

推荐阅读顺序：`app/api/main.py` → `app/application/cases/service.py` → `app/application/agents/orchestrator.py` → `main_agent.py`、`solution_agent.py`、`transaction_agent.py` → `app/application/fulfillment.py`。

## 桌面版

先安装前端依赖，再启动 Electron 开发环境：

```bash
npm --prefix frontend ci
npm --prefix desktop install && npm --prefix desktop run dev
```

开发脚本会同时启动 Vite、Electron 和动态端口上的本地 FastAPI；退出时清理子进程树。

生产打包会先构建前端，再用 PyInstaller onedir 打包后端，最后调用 electron-builder：

```bash
npm --prefix desktop run dist
```

安装包输出到 `desktop/release/`。

## API 概览

版本化 API 共 15 个 method/path，完整路径、查询参数与权限见 [`docs/api-v1.md`](docs/api-v1.md)。

| 分组 | 数量 | 能力 |
|---|---:|---|
| `cases` | 4 | 创建案件、读取状态、补充消息、订阅 SSE 事件 |
| `quotes` | 1 | 确认报价并提交交易 |
| `orders` | 2 | 查询客票，以及管理航班状态和演示数据 |
| `admin` | 7 | 规则维护、检索调试、评测集与运行、系统配置 |
| `health` | 1 | 应用与本地依赖健康检查 |

## 验证

```bash
uv run pytest -q
uv run python scripts/check_docstrings.py
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix dsh-plugin-aeroagent test
```

零 key 端到端冒烟覆盖改签、退票、报价确认、幂等提交与 SSE 事件。先在终端一启动服务，再在终端二执行脚本：

```bash
# 终端一
uv run uvicorn app.api.main:app --port 8123

# 终端二
uv run python scripts/smoke_lite.py
```

## 运维与边界

运行配置、数据位置、桌面日志和常见故障见 [`docs/runbook.md`](docs/runbook.md)。

lite 面向本地与单实例演示：仅支持单进程、单写者；进程内队列不持久，重启会丢失未执行项；本地向量检索采用线性扫描，不适合大规模规则库或多实例部署。演示令牌与 mock 航司不得作为生产身份源或真实履约通道。

## 贡献与许可证

欢迎提交 Issue 和 Pull Request。提交前请完成后端、前端与冒烟验证，commit message 使用英文并保持改动聚焦。

项目采用 [MIT License](LICENSE)。
