# DSH 插件接入

## 安装

```bash
# 1. 启动后端
uv run uvicorn app.api.main:app --host 127.0.0.1 --port 8000

# 2. 安装插件
#    推荐：DSH Web → Plugins → Add plugin → 选择 <仓库>/plugin
#    或（有 dsh CLI 时）：
npx -y -p @deepseek-ai/dsh dsh plugin --profile web add /absolute/path/AeroAgent/plugin
```

**只装到你实际打开的 Web 实例所属 profile。** DSH Desktop 的 Web 视图属于 `desktop` profile；`dsh --profile web` 启动的 Web 属于 `web` profile。插件默认 `allowedProfiles: [web]`，装到 desktop 会跳过注册；这是尽力而为的防误装，不是 DSH 原生字段。

## 配置

插件行配置：

| 字段 | 默认 | 说明 |
|---|---|---|
| `backendUrl` | `http://127.0.0.1:8000` | 后端地址，只在 Host 使用 |
| `requestTimeoutMs` | `10000` | 网关超时，1–60 秒 |
| `identityMode` | `demo` | `demo` 用演示令牌；`token` 用固定令牌 |
| `demoUserId` | `u_zhang` | 演示身份；UI 切换用户会更新 Host |
| `accessToken` | 空 | `token` 模式的 Bearer，不进入浏览器 |
| `enableAdminTools` | `false` | 是否把管理操作暴露为 Agent 工具 |
| `allowedProfiles` | `["web"]` | 允许启用插件的 profile；默认只在 web 启用（尽力而为） |

## 数据通道

- `POST /api/aeroagent/rpc`：浏览器唯一入口，同源、已认证、方法白名单。
- `GET /api/aeroagent/events?caseId=`：Host 提供的 SSE 代理；当前 Client 使用 RPC 轮询，SSE 预留给后续实时流。
- `GET /api/aeroagent/health`：后端健康与元信息。

浏览器不直连 FastAPI，不需要 CORS；令牌只存在 Host 进程。

## UI 位置

| Slot | 内容 |
|---|---|
| `sidebar.panellist` | 我的订单、Listing、低价监控、更多功能 |
| `sidebar.footer.action` | 规则、评测、数据、演示用户 |
| `main` | 业务页面 |
| `conversation.input.dock` | 订单上下文条 |
| `tool.call.toolview` | 6 个业务工具卡片 |
| `sidebar.right.pane.tab` | 执行观测 |
| `conversation.session.header.utilities` | 观测入口 |

## 验收

1. `window.__AERO_CLIENT_LOADED === true`，控制台无 slot crash。
2. 订单 → 改签 → 报价卡 → 确认 → 完成。
3. 退票、预订支付、低价监控各一条链路。
4. 灯光/暗色、窄屏、键盘焦点正常。
5. 后端停止时显示启动命令横幅，不出现白屏。
