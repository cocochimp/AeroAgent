# 机票退改签 Agent 学习工作台

面向 Agent 学员的全链路实战项目：从识别退改诉求、检索票规、计算费用、生成报价，到乘客确认、交易复核和模拟办理。管理员可编辑评测集与规则、检查检索漏斗、管理演示数据和运行配置。

> 所有航班、客票和旅客均为虚构演示数据；办理由 mock 航司适配器完成，不连接真实 GDS、支付或航司系统。

## 快速启动

需要 Docker Desktop、Node.js 和 npm：

```bash
cp .env.example .env   # 首次启动；本地保留 DEMO_AUTH=true
./start.sh
```

访问 <http://localhost:8080>。Compose 启动 React、FastAPI、worker、PostgreSQL、Redis 和 Qdrant。完整环境是默认学习入口；仅启动前端不会提供案件、订单、评测等服务端能力。

前端热更新：先运行上述服务，再执行：

```bash
cd frontend
npm ci
npm run dev
```

访问 <http://localhost:5173>。Vite 会将 `/api` 代理到 `http://127.0.0.1:8000`。后端可用 `uv run uvicorn backend.app.api.main:app --reload --port 8000` 单独启动，但仍需配置 PostgreSQL、Redis 和 Qdrant；具体说明见 [`docs/runbook.md`](docs/runbook.md)。

## 学员工作台

- **乘客对话**：订单可退改资格、改签差价、改签加退票、航班取消、指代追问、模糊日期、转人工；确认报价后才执行办理。
- **流程观测**：可折叠 Agent Trace、逐子诉求检索漏斗、候选规则分数、上下文 Token 分块、金额与依据校验。
- **评测管理**：编辑/导入/导出评测集，按范围发起真实 Agent 运行，观察进度、业务正确率、工具准确率、票规命中率、延迟、Token、失败原因和逐例 Trace，比较历史运行。
- **规则维护**：按航司、舱位、票种、场景和文本检索；检查 dense、BM25、RRF、过滤、精排、MMR、注入各阶段；编辑、停用和重新启用规则。
- **数据与配置**：管理演示客票、航班状态和会员画像；查看及更新运行参数，配置 API Key 仅返回掩码。

指标读取实际服务端运行结果。没有值时显示“本轮无数据”，不会用截图数值补齐。

### 旧工作台功能核对

| 区域 | 保留的操作 |
|---|---|
| 顶栏 | 规则/DeepSeek 模式状态、用户身份、检索状态、深浅主题 |
| 对话 | 改签差价、改签+退票、航班取消、指代追问、模糊日期、转人工；报价确认与办理结果 |
| 流程/检索/记忆/校验 | 节点 Trace 输入输出与耗时；逐子诉求检索阶段和候选分数；Token 分块与截断；置信度、金额、引用依据和错误 |
| 评测 | 评测用例搜索、编辑、导入/导出、保存、范围运行、实时进度、失败下钻、Trace、历史和双运行对比 |
| 规则 | 航司/舱位/票种/场景/文本过滤，实际检索漏斗，新增/编辑/停用/启用 |
| 数据 | 订单和画像查询、航班正常/延误/取消、画像清理、演示数据重置 |
| 配置 | 运行配置读取/保存/校验、API Key 掩码、可选 LLM 连通性检查 |

## 业务与架构

```text
乘客诉求 → 主 Agent 编排 → 方案 Agent 查询票规与费用 → 展示报价
        → 乘客明确确认 → 交易 Agent 复核 → 幂等提交 mock 航司 → 更新订单并记录审计
```

- **DDD 六边形架构**：业务规则与 FastAPI、LangGraph、数据库和队列分离。
- **四梯度会员模型**：普通、银卡、金卡、黑钻用户用于演示会员策略输入；当前价格计算按演示票规，不虚构会员减免。
- **确认后 1% 价格保护**：报价过期仍复核；降价或涨幅不超过 1% 仍按已确认金额办理，平台承担小幅差额；涨幅超过 1% 重新报价并再次确认。退款金额降低时重新确认。
- **可靠办理**：PostgreSQL 保存案件、报价、操作、账本和审计；Outbox/Redis Streams 承接后台工作；确认 ID 和幂等键防止重复办理。

## 技术栈与文档

Python 3.13、FastAPI、LangGraph、React 18、Vite、TypeScript、PostgreSQL、SQLAlchemy async、Redis Streams、Qdrant、OpenTelemetry、Docker Compose。版本化 API 共 **15 个 method/path**，见 [`docs/api-v1.md`](docs/api-v1.md)。

后端入口为 `backend.app.api.main`，DDD 代码位于 `backend/app/domain`、`application`、`adapters`、`api`。`air_agent/` 保留现有 Agent/检索实现，供 DDD 适配器调用；根目录 `app.py` 与 `web/` 是旧入口，继续保留作兼容回退，不是新工作台的页面数据源。

共享环境不能使用本地演示令牌；关闭 `DEMO_AUTH` 并配置真实身份源、密钥管理和受控配置存储。部署边界见 [`docs/runbook.md`](docs/runbook.md)。
