# dsh-plugin-aeroagent

DSH（v0.1 预览版）AeroAgent 插件，包含两部分：

1. **宿主业务工具**：注册五个只读查询工具，让本地 `aeroagent-mock` 提供方能读取订单、案件、报价、规则和评测数据。
2. **可视化客户端**：在 DSH 页面注入三栏退改签工作台，提供订单绑定、对话报价卡、真实确认/取消、评测/规则/数据学习页，以及「流程、检索、记忆、校验」执行观测。

插件不复制 AeroAgent 的票规、定价或交易逻辑。服务端工具保持只读；浏览器只有在用户明确点击报价卡按钮后，才调用现有 Quote API 或案件取消 API。

## 可视化界面

- **左上业务办理**：查询订单、改签报价、退票报价和退改对话。
- **左下业务学习**：评测、规则、数据，使用中间工作区展示，不回退独立网页。
- **订单横排卡**：点击后通过 DSH Lexical 输入框关联 `@订单号`。
- **对话报价卡**：费用明细、规则依据、确认办理和暂不办理；多个方案分别展示。
- **右侧执行观测**：固定展示当前案件的流程、检索、记忆和校验。

`202 ACCEPTED` 只表示交易已受理。客户端通过认证 SSE 和案件快照跟踪 TransactionAgent，成功后才刷新订单；重新报价需要再次确认，`RESULT_UNKNOWN` 不会自动重试。相同报价的确认重试复用同一确认号和幂等键。

## 只读工具一览

| 工具 | 参数 | 数据来源 | 说明 |
|---|---|---|---|
| `aeroagent_list_orders` | `user_id?` | `GET /api/v1/orders` | 列出乘客订单及退改试算资格；缺省用户 `u_zhang` |
| `aeroagent_get_case` | `case_id` | `GET /api/v1/cases/{case_id}` | 读取案件状态、结果和报价列表 |
| `aeroagent_get_quote` | `quote_id`、`case_id` | `GET /api/v1/cases/{case_id}` | 从案件详情的 `quotes` 中按 `quote_id` 筛选 |
| `aeroagent_list_rules` | — | `GET /api/v1/admin/rules` | 当前生效的退改政策规则（管理员演示令牌） |
| `aeroagent_get_evaluation` | — | `GET /api/v1/admin/evaluations` | 最新一次评测运行及报告 |

鉴权：普通接口用 `Authorization: Bearer demo:{user_id}`，管理员接口用 `Bearer demo-admin:{user_id}`，要求后端以 `DEMO_AUTH=true` 启动。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AEROAGENT_BACKEND_URL` | `http://127.0.0.1:8000` | 服务端工具与浏览器客户端的后端 base url |
| `AEROAGENT_DSH_ORIGINS` | `http://127.0.0.1:3080,http://localhost:3080` | 后端允许访问 API 的 DSH 页面来源，逗号分隔；配置在后端进程中 |

## 本地开发与安装

先在仓库根目录启动后端：

```bash
DEMO_AUTH=true uv run uvicorn app.api.main:app --port 8000
```

运行插件契约测试：

```bash
npm --prefix dsh-plugin-aeroagent test
```

手动验证五个服务端工具（Node 18+ 自带 fetch）：

```bash
AEROAGENT_BACKEND_URL=http://127.0.0.1:8000 node -e "
import('./dsh-plugin-aeroagent/index.js').then(async (m) => {
  const tools = [];
  m.apply({ tools: { register: (t) => tools.push(t) } });
  console.log(tools.map((t) => t.name));
});"
```

安装到 web 与 headless profile（预览版锁版本，网络受限时使用 offline）：

```bash
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile web add /absolute/path/AeroAgent/dsh-plugin-aeroagent
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile headless add /absolute/path/AeroAgent/dsh-plugin-aeroagent
```

插件包内 `cordis.patch.yml` 声明服务端工具注入方式：

```yaml
- insert:
    - id: aeroagent-tools
      name: dsh-plugin-aeroagent
      inject: [tools]
```

web 提供方和免账号演示配置见 `docs/dsh-integration.md`。修改 `client.js` 后需要重启 DSH web，因为 v0.1 会缓存组合插件包。

## 零依赖与宿主兼容

`package.json` 没有任何 `dependencies`：

- HTTP 使用 Node 18+ 和浏览器内置 `fetch`。
- `define-tool.js` 是 `@deepseek-ai/dsh-tools` 的最小 shim，只做参数规格到 JSON Schema 的转换和字段透传。
- `client.js` **不包含任何 import/export**。DSH v0.1 会把组合插件当普通脚本执行，模块语法会导致 `Unexpected token 'export'`。
- 浏览器代码由 IIFE 隔离，允许组合包与独立脚本重复执行；通过 `window.__ModuleLoader__.load({ id: "dsh-plugin-aeroagent" })` 幂等注册。
- 纯契约通过 `globalThis.AeroAgentClient` 暴露给 Node 内置测试，不引入 jsdom 或测试框架。

因此插件可离线加载，只依赖本机已经启动的 AeroAgent 后端。DSH v0.1 的 DOM 结构仍可能变化，客户端优先使用 `data-composer-input`、导航语义和 `__ModuleLoader__` 等稳定锚点。
