# AeroAgent 当前进度与并行交付计划

> 更新时间：2026-11-18。本文是当前执行台账；原始需求见 `2026-11-18-aeroagent-next-workbench-design.md`，原始五阶段计划见 `2026-11-18-aeroagent-next-workbench.md`。

## 1. 当前结论

- **DSH 原生方向已经用户确认**：保留 DSH 原生侧栏、工作区、会话、More 与右侧栏，AeroAgent 只通过官方 slots 增加模块；不再使用自绘应用框架或 iframe。
- **已可预览**：原生业务导航、真实订单列表、订单绑定、DeepSeek 对话 UI、快捷操作、消息与草稿持久化、新建退改对话、右侧观测入口。
- **后端真实 DeepSeek 基础能力已完成审查**：模式隔离、严格错误、用户与案件隔离、日期归一化、追问恢复、畸形响应防护、错误信息脱敏。
- **真实 DeepSeek 端到端复验已成功**：`c2144d6` 在 `_json` 统一满足官方小写 `json` 要求。相同案件、相同草稿返回完整退票规则，页面无错误、无重复用户消息、无报价或交易；专项代码复审通过。
- **Listing、低价监控、2–5 个改签候选、报价确认、完整学习页和四栏真实观测数据尚未完成。** 当前页面效果不能等同于全量业务验收。

## 2. 已完成提交与证据

| 范围 | 提交 | 当前证据 |
|---|---|---|
| DSH 原生 slot 骨架 | `a0736c1` | 用户确认方向；ego-lite 验证原生宿主保留、旧 `aa-app` 不加载 |
| 真实订单与选择绑定 | `c4d1773` | 真实 API 订单展示；选择后网络请求为 0；订单选择持久化 |
| DeepSeek 原生对话工作区 | `54fef8e` | 真实模型标识、消息/草稿/案件保存、快捷操作、失败重试、新建对话 |
| DeepSeek 路由与安全基础 | `32c71c3`…`8fe3a79` | 模式/用户/并发/日期/响应边界审查通过 |
| 自然语言追问恢复 | `00d7fab` | 412 项后端测试；专项复审通过；不再把整句回答写入枚举 intent |
| DeepSeek 官方错误脱敏透传 | `137d1cc` | 实施者报告 **417 passed, 1 deselected**；错误正文有界且脱敏 |
| 客户端回归 | 当前工作区 | **66/66 passed**；`git diff --check` 与 Impeccable detector 通过 |

补充验证：

- 首轮真实 DeepSeek 请求成功并创建案件。
- 独立最小工具 Schema 请求返回 HTTP 200。
- 检查点重建的 ReAct 请求返回 HTTP 200，并真实调用 `tool_rule_retrieve`。
- 旧故障案件被正确保留为 `RESULT_UNKNOWN`，没有盲重试、重复消息或自动交易。
- 浏览器只使用 ego-lite；所有提交均为本地英文提交，未 push。

## 3. 五阶段状态板

| 原始任务 | 状态 | 已完成 | 剩余交付 |
|---|---|---|---|
| Task 1：原生 DSH 与原始交互 | **进行中** | 原生导航、订单、对话骨架、右侧入口 | 用户切换、完整观测、报价确认、学习页、旧自绘死代码清理 |
| Task 2：真实 DeepSeek 基础 | **完成（含 live smoke）** | 路由、严格错误、隔离、日期、追问、脱敏；`c2144d6` 真实端到端规则答复 | 后续全量回归时继续防回归，不重复消耗 live 调用 |
| Task 3：SmartMock 多候选 | **并行启动** | 无 | 2–5 候选、校验、独立报价、推荐依据、候选身份与兄弟取消 |
| Task 4：订单搜索、OTA、监控 | **并行启动** | 订单只读列表与选择 | 时间戳/搜索、Listing、模拟支付、SQL 监控、定时评估与提醒去重 |
| Task 5：学习与最终验收 | **待集成** | 旧 vanilla 模块与测试可复用 | 学习页、文档、全量测试、真实模型和 ego-lite 全场景验收 |

## 4. 立即执行的并行分工

### Track A：真实 DeepSeek 验收（已完成）

**文件边界**：只重启/验证，不修改其他 Track 的文件。

1. 重启后端加载 `137d1cc`。**已完成**。
2. 从保留案件手动重试一次；记录脱敏后的官方错误或成功结果。**已完成，获得官方 JSON mode 错误正文**。
3. 依据官方错误正文修复单一根因。**已完成：`c2144d6` 在 `_json` 统一补入小写 `json` 要求并覆盖所有辅助能力，代码复审通过**。
4. 修复后复验并写入验收报告。**已完成：同案件同草稿返回完整退票规则；无错误、无重复消息、无交易**。后续不重复消耗 live 调用。

### Track B：Task 3A — SmartMock 纯生成与校验（独立代理）

**目标**：先交付不依赖数据库结构变更的候选生成、业务校验、独立定价与推荐理由。

**独占文件**：

- `app/application/smart_mock.py`
- `app/application/pricing.py`
- `app/application/agents/{proposal,verification}.py`
- 对应 SmartMock/pricing/proposal/verification 测试

**明确不做**：不修改 `llm.py`、postgres models/migrations、DSH UI、Booking/Watch 文件。候选持久化与 compat 序列化在 Track C 的模型变更落地后接续，避免共享文件冲突。

### Track C：Task 4 — 订单时间戳、Listing、Booking、Watch（独立代理）

**独占文件**：

- `app/adapters/outbound/postgres/models.py` 与 migrations
- `app/adapters/inbound/http/{orders,flights,bookings,watches}.py`
- `app/application/{booking,monitoring}.py`
- `app/worker.py`、`app/api/main.py`、`docs/api-v1.md`
- 对应 orders/flights/bookings/watches 测试

**明确不做**：不修改 SmartMock、DeepSeek 或 DSH UI 文件。API 契约与返回样例写入报告，供 UI Track 直接接入。

### Track D：Task 1D — 原生用户与学习页（独立 UI 代理）

**目标**：复用当前 DSH 原生结构，完成用户切换及评测/规则/数据学习页，不等待 Track B/C。

**独占文件**：

- `dsh-plugin-aeroagent/client.js`
- 新增的 native UI 测试
- `dsh-plugin-aeroagent/README.md`（如需要）

**明确不做**：不修改后端、Listing/Booking/Watch API、SmartMock。不得恢复旧自绘壳，不得隐藏 DSH DOM；继续使用宿主 React 与 `--dsw-alias-*` tokens。

### 主线集成职责

- 审查各 Track 的 scoped diff、测试和接口报告。
- 处理 Track B 后续持久化与 Track C 模型结构的唯一衔接点。
- 接入 Listing/Watch UI、报价确认和真实 Inspector 数据。
- 统一运行全量后端/前端/客户端测试及 ego-lite 验收，避免每个代理重复跑昂贵的全量浏览器场景。

## 5. 后续衔接顺序

1. **Track A 成功 smoke** → 标记真实 DeepSeek 基础 live 验收。
2. **Track C API 契约可用** → 主线接入 Listing、模拟支付和低价监控 UI。
3. **Track B 纯候选逻辑通过 + Track C 模型落地** → 仅由一个集成任务增加 candidate metadata/persistence，避免双代理修改 models。
4. **Track D 用户切换完成** → 验证订单、会话、案件、监控的用户隔离。
5. 多候选、报价确认、真实观测、学习页全部就绪后进入 Task 5 总验收。

## 6. 提速约束

- 每个代理只读自己的 task brief 和必要文件，不重复阅读整个会话历史。
- 文件所有权唯一；跨域需求通过接口报告交接，不允许顺手修改其他 Track。
- 各 Track 采用 TDD 并运行聚焦测试；全量测试由主线在集成点统一执行。若共享工作区出现他人未提交改动，只提交自己的文件并记录，不回滚他人工作。
- 每个任务只生成一个 scoped commit；reviewer 只审对应 diff。Critical/Important 未关闭不得标记完成。
- 每完成一个用户可见切片立即用 ego-lite 展示，不再等到整阶段结束。
- 不牺牲安全边界换取速度：真实交易幂等、单案件单操作、RESULT_UNKNOWN 不盲重试、严格模型错误、用户隔离和密钥脱敏均为硬门槛。

## 7. 下一次可见里程碑

- **M1（主线）**：真实 DeepSeek 端到端答复或带官方原因的明确错误证据。
- **M2（UI Track）**：原生用户切换与学习页面可在 DSH 中操作。
- **M3（API Track）**：Listing 搜索与 `PENDING_PAYMENT → ISSUED` 后端契约可用。
- **M4（SmartMock Track）**：后端能返回经校验的 2–5 个独立候选及推荐理由。
