# dsh-plugin-aeroagent

AeroAgent 的 DeepSeek Harness 插件：把机票退改签业务嵌进 DSH 原生会话与侧栏。

- **Host 半**：业务工具、同源 RPC 网关、系统提示、超时与错误归一化。
- **Client 半**：订单/航班/监控/学习页面，退改报价卡、追问选项、执行观测。
- **业务后端**：仍是仓库根目录的 `app/`（FastAPI + 三 Agent + 费用/规则/交易/航司适配）。

插件不复制票价、票规、交易或幂等逻辑；所有金额和状态以 AeroAgent 后端为准。

## 安装

```bash
# 在仓库根目录启动后端
uv run uvicorn app.api.main:app --host 127.0.0.1 --port 8000

# 安装插件到 DSH web profile
dsh plugin --profile web add /absolute/path/AeroAgent/plugin
```

也可以在 DSH 的 **Plugins → Add plugin** 中选择 `plugin/` 目录。

插件默认配置：

```yaml
backendUrl: http://127.0.0.1:8000
identityMode: demo      # demo | token
demoUserId: u_zhang
enableAdminTools: false
```

`token` 模式用于固定访问令牌；令牌只保存在 Host 进程，不进入浏览器。

## 工具

| 工具 | 作用 |
|---|---|
| `aeroagent_orders` | 订单列表/详情/多方案改签 |
| `aeroagent_flights` | 航班快照查询 |
| `aeroagent_servicing` | 改签/退票案件：start/continue/get/cancel |
| `aeroagent_booking` | 创建待支付预订/读取预订 |
| `aeroagent_watch` | 低价监控与提醒（创建需 flight_no/date/fare_product） |
| `aeroagent_knowledge` | 规则与评测 |

**确认报价和支付没有工具**：只能在 UI 的报价卡/支付按钮上由用户点击。Agent 不能代用户花钱。

## 数据通道

```
浏览器插件 → POST /api/aeroagent/rpc（DSH 同源、已认证）
          → Host 网关（注入 Bearer、超时、错误归一化）
          → FastAPI /api/v1
```

浏览器不再直连 FastAPI，也不需要 CORS。事件流通过 `GET /api/aeroagent/events?caseId=` 代理。

## 开发

```bash
npm --prefix plugin test
node --check plugin/client.js
```

`client.js` 是 DSH 组合包要求的经典脚本（无 import/export），通过 `window.__ModuleLoader__.load` 注册 React 组件。修改后重启 DSH web 或等待 HMR。

## 边界

- 演示数据、mock 航司与演示令牌不得用于生产。
- DSH 预览版 slot 契约可能变化；升级 DSH 后先跑插件测试与页面验收。
- 真实航司接入见 `docs/airline-integration.md`。
