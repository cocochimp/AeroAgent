# 架构

## 分层

| 层 | 职责 | 位置 |
|---|---|---|
| DSH 会话 | 自然语言、工具路由、会话历史、模型选择 | DSH 宿主 |
| 插件 Host | 鉴权、同源 RPC、工具、系统提示、SSE 代理 | `plugin/src/host` |
| 插件 Client | 页面、订单条、工具卡、执行观测 | `plugin/client.js` |
| 业务后端 | 三 Agent、规则检索、费用、方案、校验、交易、幂等、审计、评测 | `app/` |
| 航司端口 | submit / find_by_idempotency_key | `app/adapters/outbound/airline` |
| 持久化 | SQLite 业务库 + 只读投影 + LangGraph checkpoint | `var/` |

## 一次改签

1. 用户在 DSH 里说“帮我改签到后天”，并绑定订单。
2. DSH 模型调用 `aeroagent_servicing({action:"start", order_id, message})`。
3. Host 网关注入 Bearer，调用 `POST /api/v1/cases?wait=true`。
4. Outbox → worker → `run_case_turn`：
   - `MainServiceAgent` 理解诉求、对齐订单；
   - `ServicingAdvisorAgent` 检索票规、查航班状态、调用费用引擎；
   - `verify_node` 校验金额与证据。
5. 后端返回 `WAITING_CONFIRMATION` 和报价；工具 `presentationMeta` 把结构化数据交给 UI。
6. 插件在对话里渲染报价卡；用户点“确认办理”。
7. 客户端 RPC `quotes.confirm` → 后端重核价、幂等创建 operation → `TicketTransactionAgent` → `AirlineGateway`。
8. 案件进入 `COMPLETED / HUMAN_REVIEW / RESULT_UNKNOWN`；右侧观测展示流程、检索、记忆、校验、回执；未知结果可在回执页或报价卡发起对账。

## 控制边界

- DSH 模型只能调用白名单工具；工具入参由 JSON Schema 约束。
- 确认与支付没有工具；只能由 UI 按钮触发 RPC。
- 后端每次调用重新校验用户归属、订单状态、价格、票规、幂等键。
- 插件不复制业务规则；金额与状态以服务端为准。

## 数据

- `var/aeroagent.db`：SQLAlchemy 业务库（订单、案件、报价、操作、账本、审计等）。
- `var/air.db`：Agent 只读投影（裸 sqlite3），由 `runtime_projection` 重建。
- `var/checkpoints.db`：LangGraph 会话检查点。
