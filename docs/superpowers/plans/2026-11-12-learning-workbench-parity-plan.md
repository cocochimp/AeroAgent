# 学员工作台功能恢复与指标可观测实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 React 前端升级为完整的学员工作台，恢复旧版五个工作区、业务交互和技术面板，并从现有 Agent 运行链路提供可信指标。

**Architecture:** React 只通过 DDD FastAPI 访问工作台能力；PostgreSQL 保存权威业务状态和评测记录。`air_agent/` 继续提供 Agent 编排、检索、记忆与校验实现，由 DDD 应用层适配；静态演示种子集中在 `demo_data/`，旧 `web/` 与根 `app.py` 保留为隔离的回退入口。

**Tech Stack:** React 18、TypeScript、Vite、Vitest、FastAPI、SQLAlchemy async、PostgreSQL、Redis Streams、LangGraph、现有评测与检索组件。

**Spec:** `docs/superpowers/specs/2026-11-12-learning-workbench-parity-design.md`

## Global Constraints

- React 工作台是默认入口，用户为学习完整业务链路与技术指标的学员。
- DDD API/PostgreSQL 是工作台业务入口与业务数据权威库；Agent 复用 `air_agent/`，不得用前端规则引擎伪造完整评测。
- 新增 `demo_data/` 存放虚构静态用户、订单、画像、规则和场景；评测集仍以 `eval/gold_cases.json` 为仓库金标准。
- trace、检索漏斗、记忆预算、校验和评测指标必须由实际运行结果计算；不得把截图示例数值写死到主链路或前端。
- 高危退改办理必须二次确认、幂等执行；未确认/取消不能改变订单。
- 不删除或弱化 `air_agent/`、`web/`、`eval/`、`backend/`；本计划不执行 `backend/` → `app/` 目录迁移。
- 继续将版本化业务 API 控制在既定的 15 条以内；优先扩展已有工作台资源接口，更新 `docs/api-v1.md` 并加入路由数量断言。

## Review Focus

- PostgreSQL 中的航班/订单变更必须成为下一轮 Agent 计算的输入，而不能被旧 SQLite 副本覆盖。测试：更新航班状态后请求案件并验证非自愿规则、报价依据和数据库状态一致。
- Agent 运行发生异常或用户中断时，SSE 必须保留已发生事件并发送可解释错误，不能把失败伪装成完成。测试：中途异常后检查事件序列、最终状态和重连游标。
- 多子诉求的检索漏斗、规则引用、费用结果必须按子诉求关联，不能混用第一项结果。测试：改签+退票的两组数据各自对上规则、分数和费用。
- 编辑/导入非法评测集时，当前已保存版本和历史运行不可损坏。测试：重复 ID、缺失字段和错误结构均被拒绝且原版本可读。
- 确认重复提交、报价变化、航班取消等状态竞争不能重复办理或错误收费。测试：相同幂等键重放、确认后重算和航变后确认。

---

### Task 1: 建立统一的演示种子数据

**Files:**
- Create: `demo_data/users.json`
- Create: `demo_data/flights.json`
- Create: `demo_data/orders.json`
- Create: `demo_data/profiles.json`
- Create: `demo_data/fee_rules.json`
- Create: `demo_data/policy_rules.json`
- Create: `demo_data/scenarios/*.json`
- Create: `air_agent/demo_data.py`
- Modify: `air_agent/seed.py`
- Modify: `backend/app/adapters/outbound/postgres/seed.py`
- Test: `tests/test_demo_data.py`

**Interfaces:**
- Produces `air_agent.demo_data.load_demo_seed(now: datetime | None = None) -> dict`，返回 `users`, `flights`, `orders`, `profiles`, `fee_rules`, `policy_rules`；相对日期按 `now` 生成，JSON 不含运行指标。
- 两种数据库 seed 都消费同一加载器；旧入口与 React 工作台各自运行时隔离。

- [x] 先增加加载器测试，锁定用户/订单/规则数量、相对日期、航班状态和费用表与当前种子一致。
- [x] 运行 `uv run pytest tests/test_demo_data.py -q`，确认新加载器缺失导致失败。
- [x] 创建 fixtures 并实现加载器；`air_agent.seed` 保持现有公开 seed 函数兼容。
- [x] 修改 PostgreSQL seed 使用同一数据源，验证两个 seed 输出的业务主键集合一致。
- [x] 再运行 `uv run pytest tests/test_demo_data.py tests/test_data.py -q`。

### Task 2: 对齐 PostgreSQL 权威数据与 Agent 兼容适配

**Files:**
- Create: `backend/app/adapters/outbound/legacy/runtime_projection.py`
- Modify: `backend/app/application/cases/service.py`
- Modify: `backend/app/adapters/outbound/legacy/policy_sync.py`
- Modify: `backend/app/application/agents/__init__.py`
- Modify: `backend/app/adapters/inbound/http/orders.py`
- Modify: `backend/app/adapters/inbound/http/admin.py`
- Modify: `backend/app/adapters/outbound/postgres/models.py`
- Test: `tests/test_runtime_projection.py`
- Test: `tests/test_api.py`

**Interfaces:**
- `sync_agent_projection(session: AsyncSession) -> None` 将 PostgreSQL 当前航班、订单、用户画像、费用规则、政策规则投影到现有 Agent 兼容边界；PostgreSQL 保持唯一业务事实源。
- 管理员工作区读取全量演示用户/画像/订单；支持设置航班状态、清理画像、重置种子。乘客订单查询仍仅返回本人数据。
- Agent 运行前投影业务数据，运行后的画像增量回写 PostgreSQL；case/quote/operation/audit 保持现有 DDD 用例边界。

- [x] 先增加子进程导入测试，断言 `from backend.app.api.main import app` 可执行；当前基线在 `agents/__init__.py` eager import 经 `transaction_agent → fulfillment → cases.service` 形成循环，此测试作为任务前置回归。
- [x] 增加 API/适配器测试：管理员写入取消状态后，投影和 Agent 票价计算均读取 PostgreSQL 的当前状态；乘客不可读取他人订单。
- [x] 运行相关用例并确认新增路由/投影尚未实现时失败。
- [x] 实现投影与管理数据操作，重置时以 `demo_data/` 重建 PostgreSQL、Agent 兼容数据和检索索引。
- [x] 将 `GET /orders` 扩展为管理员可读取用户/画像/全量订单，将 `POST /orders` 扩展为受管理员保护的 `set_flight_status | clear_profile | reset_demo_data` 命令；用 `/admin/evaluations?view=run&run_id=...` 承接单次运行详情并移除冗余的运行详情 path，确保版本化 API 总操作数不超过 15。
- [x] 运行 `uv run pytest tests/test_api.py tests/test_runtime_projection.py -q`。

### Task 3: 输出完整运行事件与可重连的案件详情

**Files:**
- Modify: `backend/app/application/cases/service.py`
- Modify: `backend/app/adapters/inbound/http/cases.py`
- Modify: `backend/app/adapters/outbound/postgres/models.py`
- Modify: `backend/migrations/versions/0001_initial.py` or add a new migration
- Test: `tests/test_api.py`

**Interfaces:**
- 案件结果保留 `final`, `interrupt`, `trace`, `results`, `context`, `memory`, `verify`；SSE `case.trace` 事件逐项包含 allowlist 后的 `node/status/ms/at/note/input/output`。
- 案件详情和事件重放使用已有 `/cases/{case_id}`、`/cases/{case_id}/events`；浏览器刷新可按游标恢复，不新增独立 trace API。
- 业务正文、密钥、身份凭证不得进入 trace；订单/规则只记录演示 ID 和必要字段。

- [x] 写 API 测试，断言正常运行的 SSE 含流程节点和完整详情，按游标重连不重复/漏事件；错误中断事件可读。
- [x] 运行测试确认事件 payload 缺字段/游标行为不符合预期。
- [x] 更新 worker 回调事件 allowlist、PostgreSQL 存储与事件读取；保留结构化结果中的子诉求检索、上下文、校验数据。
- [x] 增加确认、取消、幂等重放的用例事件测试；确认消息不可绕过报价确认端点。
- [x] 运行 `uv run pytest tests/test_api.py -q`。

### Task 4: 恢复完整评测执行与结果分析 API

**Files:**
- Modify: `backend/app/application/evaluations.py`
- Modify: `air_agent/evaluation.py`
- Modify: `backend/app/adapters/inbound/http/admin.py`
- Modify: `backend/app/worker.py`
- Test: `tests/test_evaluation.py`
- Test: `tests/test_api.py`

**Interfaces:**
- 每条 `EvalCaseResult` 保存期望/实际意图、工具序列、金额、规则 ID、业务结局、Schema 错误、forbid 命中、trace、耗时和 Token。
- 每次运行 summary 计算 `correctness`, `tool_acc`, `policy_hit`, `human_rate`, `latency_avg_ms`, `latency_p95_ms`, `tokens_avg`, `n`, `failure_reasons`。
- 评测用例仍使用原 `id/title/tags/user_id/airline/fare_product/order/question/history/clarify_answers/expect/forbid` 结构；导入导出使用同一结构。
- 每个运行记录绑定启动时的 `EvaluationCaseSetRecord.version` 和 case snapshot；worker 不能意外评测后来修改的评测集。

- [x] 增加针对完整 gold set 的离线评测测试：核对金额、规则命中、工具序列、结果结局和禁止行为；不能只比较意图。
- [x] 增加失败分类、百分位延迟、空结果集和历史报告持久化测试。
- [x] 实现运行进度落库与完整评测报告到 PostgreSQL 的写回；worker 从该运行绑定的 case snapshot 取数，按实际 `case_ids` 选择运行。
- [x] 为单用例报告提供期望/实际字段和完整 trace；历史 API 支持查看与双运行差异。
- [x] 运行 `uv run pytest tests/test_evaluation.py tests/test_api.py -q`，并执行一次完整离线 gold 评测。

### Task 5: 重建 React 学员工作台框架和业务交互

**Files:**
- Modify: `frontend/src/app/App.tsx`
- Create: `frontend/src/app/WorkbenchShell.tsx`
- Create: `frontend/src/app/ChatWorkspace.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/styles.css`
- Modify: `frontend/vite.config.ts`
- Test: `frontend/src/app/ChatWorkspace.test.tsx`

**Interfaces:**
- Shell 导航路径为 `chat/eval/rules/data/config`；顶栏提供模式、用户、检索状态、主题。
- 提供乘客/管理员视角切换，使用现有 demo identity 生成对应身份 token；管理员能力由服务端角色校验，不只靠前端隐藏控件。
- API client 使用 `/api/v1`，以 SSE 消费案件事件；任何页面不得直接导入 `frontend/src/demo/service.ts` 作为完整业务运行源。
- 六类快捷场景保留；同一会话按 case ID 展示 trace 和报价；只有确认按钮调用报价确认 API。

- [x] 增加渲染与交互测试：五页可导航、切换用户刷新订单、快捷诉求发起案件、等待报价事件、未确认不调用确认 API。
- [x] 运行 `npm test -- --reporter=dot` 确认新壳层/聊天工作区测试失败。
- [x] 实现 React 工作台 shell、认证演示身份、API/SSE client、订单卡片、消息与报价确认流程。
- [x] 为 SSE 中断/重连、无 DeepSeek key、航班取消和转人工增加交互测试。
- [x] 运行 `npm test -- --reporter=dot && npm run build`。

### Task 6: 实现可解释运行面板

**Files:**
- Create: `frontend/src/app/ExecutionPanel.tsx`
- Create: `frontend/src/app/TraceTimeline.tsx`
- Create: `frontend/src/app/RetrievalFunnel.tsx`
- Create: `frontend/src/app/MemoryInspector.tsx`
- Create: `frontend/src/app/VerificationPanel.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/app/ExecutionPanel.test.tsx`

**Interfaces:**
- `ExecutionPanelProps = { result: CaseResult | null; events: TraceEvent[]; config: RuntimeConfig }`。
- 四个面板字段来自 Task 3 的运行数据：trace 节点/输入输出/耗时；检索各 stage `count/k/items/score`；记忆块 `tokens/budget/truncated`；校验 `confidence/threshold/support_ratio/retries/fee comparison/references/errors`。
- 对多个子诉求支持切换，各自筛选其 funnel/fee/rule data；缺少指标显示“本轮无数据”，不回填固定演示数。

- [x] 增加组件测试：每个阶段显示服务端实际数量、配置上限、候选 ID/分数；双诉求切换不串数据；空数据不生成虚假指标。
- [x] 实现可折叠 timeline、检索条形漏斗与候选列表、Token 分块图、置信度/金额/依据校验。
- [x] 增加窄屏执行面板抽屉和键盘无障碍测试。
- [x] 运行 `npm test -- --reporter=dot && npm run build`。

### Task 7: 恢复评测、规则、数据和配置管理页面

**Files:**
- Create: `frontend/src/app/EvaluationWorkspace.tsx`
- Create: `frontend/src/app/EvaluationResults.tsx`
- Create: `frontend/src/app/RulesWorkspace.tsx`
- Create: `frontend/src/app/DataWorkspace.tsx`
- Create: `frontend/src/app/ConfigWorkspace.tsx`
- Create: `frontend/src/app/admin-workspaces.test.tsx`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Workspace 只调用 DDD API：评测集 CRUD/导入/导出/范围运行/历史；规则筛选、保存和检索 debug；管理员数据查询/航班状态/画像清理/重置；运行参数读写/校验。
- 评测 dashboard 显示完整 metrics、航司×票种热图、失败分布、逐字段下钻、trace 和两次运行比较。
- 删除规则用现有 rule upsert 的停用能力；所有编辑/重置动作有明确成功失败状态。

- [x] 增加工作区测试：评测过滤与导入校验、运行进度/历史比较、规则漏斗、取消航班设置、配置范围错误/API key 打码。
- [x] 实现五个工作区，保留旧版所有可操作功能及既有 `eval/gold_cases.json` 字段。
- [x] 运行 `npm test -- --reporter=dot && npm run build`。

### Task 8: 功能对照、文档与最终验证

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook.md`
- Modify: `docs/api-v1.md`
- Modify: `docs/superpowers/plans/2026-11-12-learning-workbench-parity-plan.md`
- Test: `tests/test_api.py`, `tests/test_evaluation.py`, `frontend/src/**/*.test.tsx`

- [ ] 将旧版五个工作区、顶栏功能、六类场景、四个解释面板、评测指标和 data/config 操作列成核对清单。
- [ ] 浏览器验证完整规则模式改签、退票、航班取消、追问、转人工；确认后订单及 trace 正确。
- [ ] 浏览器验证规则调试漏斗、评测全量运行/失败下钻/历史对比、数据修改重置和配置保存生效。
- [ ] 在宽屏和窄屏验证；DeepSeek 未配置时规则模式仍可用，DeepSeek 选择有明确配置提示。
- [ ] 运行 `uv run pytest -q`、`npm test -- --reporter=dot`、`npm run build`，修复失败并记录结果。
- [ ] 更新 README/runbook 的开发启动与依赖说明；旧代码仅在新工作台达成逐项验收后才考虑退役。
