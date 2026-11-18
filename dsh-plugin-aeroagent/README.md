# dsh-plugin-aeroagent

DSH（v0.1 预览版）业务工具插件：向宿主注册 AeroAgent 退改签工作台的**只读**查询工具，让 DSH 里的模型（如本地 `aeroagent-mock` 提供方）能实时拉取订单、案件、报价、政策规则和评测结果等演示数据。

插件本身不含任何业务逻辑，所有数据都通过 HTTP 转发到本机 AeroAgent 后端；不做任何写操作。

## 工具一览

| 工具 | 参数 | 数据来源 | 说明 |
|---|---|---|---|
| `aeroagent_list_orders` | `user_id?` | `GET /api/v1/orders` | 列出乘客订单及退改试算资格；缺省用户 `u_zhang` |
| `aeroagent_get_case` | `case_id` | `GET /api/v1/cases/{case_id}` | 读取案件状态、结果和报价列表 |
| `aeroagent_get_quote` | `quote_id`、`case_id` | `GET /api/v1/cases/{case_id}` | 后端无独立报价接口，从案件详情的 `quotes` 中按 `quote_id` 筛选，故需同时传 `case_id` |
| `aeroagent_list_rules` | — | `GET /api/v1/admin/rules` | 当前生效的退改政策规则（管理员演示令牌） |
| `aeroagent_get_evaluation` | — | `GET /api/v1/admin/evaluations` | 最新一次评测运行：先 `view=runs` 取首条 `run_id`，再 `view=run` 拿报告 |

鉴权：普通接口用 `Authorization: Bearer demo:{user_id}`，管理员接口（rules/evaluations）用 `Bearer demo-admin:{user_id}`，要求后端以 `DEMO_AUTH=true` 启动（免登录、零 Key）。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AEROAGENT_BACKEND_URL` | `http://127.0.0.1:8000` | AeroAgent 后端 base url，插件所有请求都指向它 |

## 本地开发与安装

前置：在仓库根目录启动后端。

```bash
DEMO_AUTH=true uv run uvicorn app.api.main:app --port 8000
```

手动验证工具数据源（Node 18+ 自带 fetch）：

```bash
AEROAGENT_BACKEND_URL=http://127.0.0.1:8000 node -e "
import('./index.js').then(async (m) => {
  const tools = [];
  m.apply({ tools: { register: (t) => tools.push(t) } });
  console.log(tools.map((t) => t.name));
});"
```

安装到 DSH（预览版请锁版本，网络受限时给 npx 加 `--offline`）：

```bash
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile headless add <repo>/dsh-plugin-aeroagent
```

插件包内 `cordis.patch.yml` 已声明注入方式（`inject: [tools]`），安装命令会自动应用；手动配置 profile patch 时照抄即可：

```yaml
- insert:
    - id: aeroagent-tools
      name: dsh-plugin-aeroagent
      inject: [tools]
```

## 零依赖说明

`package.json` 没有任何 `dependencies`：

- HTTP 用 Node 18+ 内置的全局 `fetch`，不引第三方请求库；
- `define-tool.js` 是 `@deepseek-ai/dsh-tools` 中 `defineTool` 的**内置最小 shim**——只做「参数规格 → JSON Schema」转换和字段透传。内置的原因：一是避免学员安装插件时再走一次 npm 网络拉取（预览版包源不稳定，易超时）；二是 DSH v0.1 的工具定义格式仍可能变动，本地 shim 可以随仓库一起改，不被上游版本锁死。

因此插件可以在完全离线的环境下被 DSH 加载运行，仅依赖本机已启动的 AeroAgent 后端。
