# DSH 接入指南（学员版）

本文说明如何在本机把 AeroAgent 接入 DSH（DeepSeek Harness），并只在 DSH 内完成机票查询、退改报价、确认办理和业务学习。默认使用真实 DeepSeek（密钥只保存在后端环境），`aeroagent-mock` 仅用于离线回归，且不回退独立网页。

> DSH 当前为 v0.1 预览版。请锁定 `@deepseek-ai/dsh@0.1.x`；网络受限时使用 `--offline` 或提前安装。AeroAgent 后端仍需单独启动，但学员的业务操作都在 DSH 中完成。

## 最终界面

- **左上「业务办理」**：我的订单、Listing、低价监控、更多功能。
- **左下「业务学习」**：评测、规则、数据，切换中间工作区，不离开 DSH。
- **对话上方客票上下文条**：绑定当前客票，快捷操作只填入输入框。
- **对话内方案区块**：费用明细、票规依据；多个可办理方案分别成区块，不显示内部 JSON。
- **右侧「执行观测」**：显示流程、检索、记忆、校验，以及案件和订单状态。

## ① 启动 AeroAgent 后端

在仓库根目录执行：

```bash
DEMO_AUTH=true uv run uvicorn app.api.main:app --host 127.0.0.1 --port 8000
```

- 首次启动自动初始化 `var/aeroagent.db`、演示订单、规则和内嵌 worker。
- `DEMO_AUTH=true` 允许本地演示令牌 `demo:u_zhang` 和 `demo-admin:u_zhang`，仅用于本机演示。
- 自检：`curl -fsS http://127.0.0.1:8000/api/v1/health`。
- 浏览器从 DSH 的 3080 端口访问后端的 8000 端口，默认只放行 `http://127.0.0.1:3080` 和 `http://localhost:3080`。自定义端口时，在启动后端前设置逗号分隔的 `AEROAGENT_DSH_ORIGINS`，不要使用通配符来源。

## ② 安装可视化业务插件

```bash
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile web add /absolute/path/AeroAgent/dsh-plugin-aeroagent
```

插件没有 npm runtime dependencies。它同时提供：

1. 五个只读宿主工具；
2. 零 import/export 的可视化 `client.js`，负责三栏布局、报价卡、确认与执行观测。

如需 headless 工具验证，再执行：

```bash
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile headless add /absolute/path/AeroAgent/dsh-plugin-aeroagent
```

> 修改 `client.js` 后需要重启 DSH web。v0.1 会缓存组合插件包，仅刷新浏览器可能仍加载旧代码。

## ③ 配置本地提供方并启动 DSH

在 web profile 的 `cordis.patch.yml` 中合并以下配置。若使用隔离环境，可设 `DSH_HOME=/tmp/dsh-home`，profile 路径即为 `/tmp/dsh-home/profiles/web/cordis.patch.yml`。

```yaml
# AeroAgent 服务端工具
- insert:
    - id: aeroagent-tools
      name: dsh-plugin-aeroagent
      inject: [tools]

# 仅限本机免账号演示
- id: authorization
  disabled: true
- id: deepseek-account
  disabled: true
- id: account-controller
  disabled: true
- id: llm-deepseek-account
  disabled: true

# OpenAI 兼容提供方
- id: llm-pi-ai
  config:
    providers:
      aeroagent:
        apiKeyEnv: AEROAGENT_STUB_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:8000/v1
        models:
          - id: aeroagent-deepseek
            input: [text]
- id: agent-default-model
  config:
    provider: aeroagent
    model: aeroagent-deepseek
```

启动 web：

```bash
DSH_HOME=/tmp/dsh-home AEROAGENT_STUB_KEY=dummy \
  npx --offline @deepseek-ai/dsh@0.1.x --profile web
```

`AEROAGENT_STUB_KEY` 只是宿主配置占位符，不会用于外部模型请求。使用终端输出的完整 token 链接打开 DSH；服务重启后 token 可能变化，不要长期使用旧链接。

后端提供：

- `GET /v1/models`
- `POST /v1/chat/completions`，支持 SSE stream 和宿主 `tool_calls`。
- 每个 AeroAgent 答复包含不可见的案件元数据，下一轮恢复原案件和会话，不会把追问误建成新案件。
- 可办理报价由后端渲染为乘客可读的方案区块，内部 `quote_id` 不出现在正文；明细同时保留在执行观测栏。
- 原生会话以选中客票的归属确定乘客（`@订单号`）；同一会话换到另一张客票时自动按新客票开案，不会串用旧案件。

## 学员操作与交易状态

1. 点击订单卡，或从左上选择改签／退票快捷入口。
2. 检查输入框中的 `@订单号` 和诉求，明确发送。
3. 等待报价卡，核对费用、目标航班与规则依据。
4. 点击「确认办理」后：
   - `202 ACCEPTED` 仅表示受理，界面显示办理中，**不是办理成功**。
   - 客户端通过认证 SSE 和案件快照跟踪 TransactionAgent。
   - 成功后订单变为 `CHANGED` 或 `REFUNDED`，订单卡与右侧案件状态同步刷新。
   - 价格变化时生成新报价，必须再次明确确认。
   - `RESULT_UNKNOWN` 表示结果待核对，不会自动重试；确认重试复用同一幂等键。
5. 点击「暂不办理」会真实取消案件和报价，不只是隐藏卡片，且不会创建交易。
6. 右侧切换流程、检索、记忆、校验；左下进入评测、规则、数据学习页。

## 自动化与浏览器验收

运行客户端契约测试：

```bash
npm --prefix dsh-plugin-aeroagent test
```

运行相关后端测试：

```bash
uv run pytest -q tests/test_openai_compat.py tests/test_dsh_cors.py \
  tests/test_issue_ticket.py tests/test_confirmation_concurrency.py
```

开发验收使用 ego-lite 打开 DSH token 链接，至少验证：

- `window.__AERO_CLIENT_LOADED === true`，没有插件加载异常；
- 左上/左下导航、订单绑定、四个右侧页签；
- 退票和改签各一条真实确认链路，最终订单状态正确；
- 取消后案件为 `CANCELLED` 且没有交易；
- 追问前后 `case_id` 不变；
- 学习页数据来自真实后端。

## MCP 只读接入（可选）

不想安装业务工具、或宿主只支持 MCP 时，可使用仓库内置只读 MCP server（`python -m app.mcp`，纯标准库、stdio、协议版本 `2024-11-05`）。它暴露与插件相同的五个只读工具，数据来自本机后端。

```json
{
  "mcpServers": {
    "aeroagent": {
      "command": "uv",
      "args": ["run", "python", "-m", "app.mcp"],
      "cwd": "/absolute/path/AeroAgent",
      "env": {
        "AEROAGENT_BACKEND_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

自动化验收：`uv run pytest -q tests/test_mcp_server.py`。MCP 只提供只读数据，不替代可视化报价卡中的显式 Quote API 确认。

## 预览版边界

- DSH v0.1 的 DOM 和组合加载方式可能变化；客户端优先使用 `data-composer-input`、导航语义和 `__ModuleLoader__` 锚点。
- 普通脚本不能包含 import/export；IIFE 和幂等注册用于兼容组合包与独立脚本重复执行。
- 本方案不包含由 DSH 自动托管 AeroAgent 后端进程的能力。
- 演示令牌、mock 航司和关闭宿主鉴权不得用于生产环境。
