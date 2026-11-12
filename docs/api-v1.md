# FastAPI v1 接口

当前 DDD 应用开放 **15 个 method/path**。接口按用途合并在既有资源路由中，未新增独立 Trace、评测运行详情或数据管理路径。

| # | 方法 | 路径 | 用途 |
|---:|---|---|---|
| 1 | POST | `/api/v1/cases` | 创建案件并启动主 Agent |
| 2 | GET | `/api/v1/cases/{case_id}` | 读取当前用户案件、结果和报价 |
| 3 | POST | `/api/v1/cases/{case_id}/messages` | 补充信息、继续流程或取消待确认案件 |
| 4 | GET | `/api/v1/cases/{case_id}/events` | SSE 案件事件流；支持 `Last-Event-ID` 或 `after` 游标 |
| 5 | POST | `/api/v1/quotes/{quote_id}/confirm` | 确认报价并提交交易 Agent |
| 6 | GET | `/api/v1/orders` | 乘客读取本人客票；管理员读取全量客票、用户和画像 |
| 7 | POST | `/api/v1/orders` | 管理员设置航班状态、清理画像或重置演示数据 |
| 8 | GET | `/api/v1/admin/rules` | 管理员筛选规则；`debug=true` 返回过滤结果，带 `q` 时附真实检索各阶段漏斗 |
| 9 | PUT | `/api/v1/admin/rules/{rule_id}` | 新增/更新/停用规则并记录审计 |
| 10 | GET | `/api/v1/admin/evaluations` | 查询评测集、运行历史或单次运行详情 |
| 11 | PUT | `/api/v1/admin/evaluations/cases` | 保存有版本号的评测集 |
| 12 | POST | `/api/v1/admin/evaluations/runs` | 按全部或指定 case IDs 提交异步评测 |
| 13 | GET | `/api/v1/admin/config` | 读取运行配置；API Key 打码 |
| 14 | PUT | `/api/v1/admin/config` | 更新配置，可选 LLM 连通性探测 |
| 15 | GET | `/api/v1/health` | 检查应用与依赖健康状态 |

## 复用查询参数

- `GET /api/v1/admin/evaluations?view=cases`：读取当前评测集及版本；`view=runs`：读取最近运行历史；`view=run&run_id=...`：读取单次运行进度、报告和快照版本。
- `POST /api/v1/admin/evaluations/runs` body 可选 `case_ids`，不传则运行全部用例；`mode` 为 `offline` 或 `deepseek`。
- `GET /api/v1/admin/rules` 支持 `airline`、`cabin`、`fare_product`、`scenario`、`q` 和 `debug` 参数。
- `POST /api/v1/orders` body `action` 支持 `set_flight_status`、`clear_profile`、`reset_demo_data`。

所有接口使用 Bearer token。案件/报价按当前 principal 做用户归属校验；管理员接口和管理员数据命令要求 `admin` role。仅本地/演示环境接受 `demo:u_zhang` 一类演示令牌；共享环境必须关闭 `DEMO_AUTH` 并接入企业身份源与强密钥。

报价确认时即使原报价过期仍会重新计算：降价或涨幅不超过 1% 时仍按已确认金额办理；涨幅超过 1% 生成新报价并要求再次确认。退款金额降低时重新报价并再次确认。
