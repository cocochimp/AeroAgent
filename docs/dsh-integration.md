# DSH 接入指南（学员版）

本文面向课程学员，说明如何在本机把 AeroAgent 接入 DSH（DeepSeek Harness）：把本地后端当作模型提供方、安装业务工具插件，以及可选的 MCP 只读接入。全程免登录、零 API Key。

> 版本提示：DSH 当前为 **v0.1 预览版**，接口与配置格式可能变动，请务必**锁定版本**安装（如 `@deepseek-ai/dsh@0.1.x`），不要跟随 latest。网络受限时给 npx 加 `--offline`（或提前 `npm i -g` 后用本地命令），规避安装期网络超时。

## 三步骤接入

### ① 启动 AeroAgent 本地后端

在仓库根目录执行：

```bash
DEMO_AUTH=true uv run uvicorn app.api.main:app --port 8000
```

- `DEMO_AUTH=true` 开启演示令牌：后端接受 `Bearer demo:u_zhang`（普通用户）与 `Bearer demo-admin:u_zhang`（管理员）这类明文令牌，**免登录、零 Key**。
- 首次启动会自动建表（SQLite，落在 `var/aeroagent.db`）并灌入演示订单/规则数据。
- 自检：`curl -s http://127.0.0.1:8000/api/v1/health`。

### ② DSH 配置自定义提供方

AeroAgent 后端暴露 OpenAI 兼容端点（`GET /v1/models`、`POST /v1/chat/completions`），可直接注册为 DSH 的自定义提供方。在 DSH 的 settings patch（YAML）中加入：

```yaml
# dsh.settings.patch.yml —— 注册 AeroAgent 本地提供方
- insert:
    - id: aeroagent-provider
      name: AeroAgent Local
      type: openai-compat
      baseURL: http://127.0.0.1:8000/v1
      apiKey: not-needed          # mock 档不校验 Key，占位即可（免登录零 Key）
      models:
        - id: aeroagent-mock
          name: AeroAgent mock 档（本地确定性链路）
```

说明：

- `aeroagent-mock` 档完全跑本地退改签主链，不请求任何外部 LLM，因此 `apiKey` 只是占位符。
- 宿主请求带上业务工具时，mock 档会在合适时机返回 `tool_calls` 委派给 ③ 安装的插件工具，再把工具结果汇总成答复。
- 字段名以本机安装的 DSH v0.1 文档为准；预览版格式若有出入，只需保证 `baseURL` 指向 `http://127.0.0.1:8000/v1`、模型 ID 为 `aeroagent-mock`。

### ③ 安装 AeroAgent 业务工具插件

插件源码在本仓库 `dsh-plugin-aeroagent/` 目录（零运行时依赖，见该目录 README.md）。用 DSH CLI 从本地路径安装：

```bash
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile headless add <repo>/dsh-plugin-aeroagent
```

对应的 profile patch insert 片段（插件包内 `cordis.patch.yml` 已自带，手动配置时参考）：

```yaml
# AeroAgent 业务工具层：向宿主注册退改签只读工具
- insert:
    - id: aeroagent-tools
      name: dsh-plugin-aeroagent
      inject: [tools]
```

安装后在 headless profile 里向 `aeroagent-mock` 提问「查一下我的订单」，模型会调用 `aeroagent_list_orders` 返回演示订单（ORD 开头单号）。

## MCP 只读接入（可选）

不想装插件、或宿主只支持 MCP 时，可用仓库内置的只读 MCP server（`python -m app.mcp`，纯标准库、stdio 传输、协议版本 `2024-11-05`）。它暴露五个只读工具：`aeroagent_list_orders`、`aeroagent_get_case`、`aeroagent_get_quote`、`aeroagent_list_rules`、`aeroagent_get_evaluation`，数据全部来自 ① 的后端。

DSH 侧通过 dsh-mcp-manager 注册，或直接在 Claude Desktop 的 MCP 配置（`claude_desktop_config.json`）中加入同一段 stdio 配置：

```json
{
  "mcpServers": {
    "aeroagent": {
      "command": "uv",
      "args": ["run", "python", "-m", "app.mcp"],
      "cwd": "<repo 绝对路径>",
      "env": {
        "AEROAGENT_BACKEND_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

- 使用前先确保 ① 的后端在跑；`AEROAGENT_BACKEND_URL` 不设置时默认 `http://127.0.0.1:8000`。
- 手动自检：把三条 JSON-RPC（`initialize` / `tools/list` / `tools/call`）按行管道进 `uv run python -m app.mcp`，应逐行返回 JSON 响应。
- 自动化验收：`uv run pytest -q tests/test_mcp_server.py`（测试内嵌假后端，自包含，不依赖真实服务）。
