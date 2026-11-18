# FastAPI v1 接口

当前 DDD 应用开放 **25 个 method/path**。接口按用途合并在既有资源路由中，未新增独立 Trace、评测运行详情或数据管理路径。

| # | 方法 | 路径 | 用途 |
|---:|---|---|---|
| 1 | POST | `/api/v1/cases` | 创建案件并启动主 Agent |
| 2 | GET | `/api/v1/cases/{case_id}` | 读取当前用户案件、结果和报价 |
| 3 | POST | `/api/v1/cases/{case_id}/messages` | 补充信息、继续流程或取消待确认案件 |
| 4 | GET | `/api/v1/cases/{case_id}/events` | SSE 案件事件流；支持 `Last-Event-ID` 或 `after` 游标 |
| 5 | POST | `/api/v1/quotes/{quote_id}/confirm` | 确认报价并提交交易 Agent |
| 6 | GET | `/api/v1/orders` | 搜索、排序并分页读取客票；管理员额外读取用户和画像 |
| 7 | POST | `/api/v1/orders` | 管理员设置航班状态、清理画像或重置演示数据 |
| 8 | GET | `/api/v1/admin/rules` | 管理员筛选规则；`debug=true` 返回过滤结果，带 `q` 时附真实检索各阶段漏斗 |
| 9 | PUT | `/api/v1/admin/rules/{rule_id}` | 新增/更新/停用规则并记录审计 |
| 10 | GET | `/api/v1/admin/evaluations` | 查询评测集、运行历史或单次运行详情 |
| 11 | PUT | `/api/v1/admin/evaluations/cases` | 保存有版本号的评测集 |
| 12 | POST | `/api/v1/admin/evaluations/runs` | 按全部或指定 case IDs 提交异步评测 |
| 13 | GET | `/api/v1/admin/config` | 读取运行配置；API Key 打码 |
| 14 | PUT | `/api/v1/admin/config` | 更新配置，可选 LLM 连通性探测 |
| 15 | GET | `/api/v1/health` | 检查应用与依赖健康状态 |
| 16 | GET | `/api/v1/flights` | 按航线、日期、舱位读取本地 SQL Listing 与可用状态 |
| 17 | POST | `/api/v1/bookings` | 按服务端票价快照创建 `PENDING_PAYMENT` 预订 |
| 18 | GET | `/api/v1/bookings/{booking_id}` | 读取当前用户自有预订与支付状态 |
| 19 | POST | `/api/v1/bookings/{booking_id}/pay` | 幂等 Mock Payment，将订单迁移为 `ISSUED` |
| 20 | POST | `/api/v1/watches` | 以当前 SQL 总价为基线创建持久化低价监控 |
| 21 | GET | `/api/v1/watches` | 列出当前用户自有监控 |
| 22 | GET | `/api/v1/watches/alerts` | 读取当前用户的 DSH 站内提醒历史 |
| 23 | POST | `/api/v1/watches/{watch_id}/evaluate` | 立即写入一次 `manual` 价格观测并评估阈值 |
| 24 | GET | `/api/v1/watches/{watch_id}` | 读取自有监控及最近 50 条观测和提醒 |
| 25 | GET | `/api/v1/cases/latest` | 读取当前用户最近创建的案件，供原生 DSH 会话观测使用 |

## 通用约定

所有业务接口使用 Bearer token。案件、报价、预订和监控按当前 principal 做用户归属校验；他人资源统一返回 404，管理员也不能通过请求参数切换这些资源的所有者。管理员接口和管理员数据命令要求 `admin` role。仅本地/演示环境接受 `demo:u_zhang` 一类演示令牌；共享环境必须关闭 `DEMO_AUTH` 并接入企业身份源与强密钥。

金额均为整数最小展示单位，当前快照币种为 `CNY`；`total = fare + tax`。时间字段序列化为 ISO 8601。请求模型拒绝未知字段，客户端不能注入 `user_id`、价格、币种、订单状态或票号。

报价确认时即使原报价过期仍会重新计算：降价或涨幅不超过 1% 时仍按已确认金额办理；涨幅超过 1% 生成新报价并要求再次确认。退款金额降低时重新报价并再次确认。

## 订单搜索、排序与分页

`GET /api/v1/orders` 支持：

- `q`：可选，最长 100 字符；匹配订单号、用户、乘客、航班号、航司、日期、状态及航线城市/机场。SQL 通配符按字面值转义。
- `sort=created_at|departure`：默认 `created_at`。`departure` 按订单日期、航班起飞时刻排序。
- `order=asc|desc`：默认 `desc`，因此默认结果为最近创建优先。
- `page`：从 1 开始，默认 1；`page_size`：1–100，默认 20。
- 排序均追加 `order_id` 作为同方向确定性次序，分页不会在同键记录间漂移。

响应保留 `orders`，并增加 `q`、`sort`、`order`、`page`、`page_size`、`total`、`total_pages`。每个订单包含 `created_at`、`updated_at`、`paid_at`、`currency`；待支付订单的退改资格为 `allowed=false / ORDER_NOT_ISSUED`。查询和点击订单聊天均为只读/前端行为，不创建付费调用。

管理员响应仍保留 `users` 与 `profiles`。`POST /api/v1/orders` 的 `action` 支持 `set_flight_status`、`clear_profile`、`reset_demo_data`；重置会同时清理预订、监控、观测和提醒，再重建演示快照。

## Listing（本地 SQL 快照）

`GET /api/v1/flights` 支持可选 `origin`、`dest`、`date=YYYY-MM-DD`、`cabin=F|C|Y`、`flight_no`。结果按日期、起飞时刻、航班号稳定排序：

```json
{
  "flights": [{
    "flight_no": "MU5101", "date": "2026-11-20", "airline": "MU",
    "origin": "HGH", "dest": "PEK", "origin_city": "杭州", "dest_city": "北京",
    "dep_time": "07:00", "duration_min": 130, "status": "scheduled", "delay_min": 0,
    "available": true, "unavailable_reason": null, "inventory_source": "local_sql_snapshot",
    "fares": [{"fare_product": "Y", "cabin": "Y", "fare": 1500, "tax": 50,
               "total": 1550, "currency": "CNY", "available": true}]
  }],
  "total": 1
}
```

取消航班仍返回，`available=false`、`unavailable_reason=FLIGHT_CANCELLED`，其 fares 也不可用。其他非计划状态为 `FLIGHT_NOT_BOOKABLE`，无票价为 `FARE_UNAVAILABLE`。舱位筛选只返回具有该舱位票价的航班。Listing 不代表实时库存。

## 快照预订与 Mock Payment

创建预订：

```http
POST /api/v1/bookings
{"flight_no":"MU5101","date":"2026-11-20","fare_product":"Y","passenger":"张三"}
```

成功返回 HTTP 201。服务端重新读取 SQL 航班和票价，忽略且拒绝客户端金额/用户字段，创建 `PENDING_PAYMENT` 订单、预订记录及 `booking.created` 审计，并刷新 Agent 只读投影。`ticket_no=""`、`paid_at=null`，`inventory_source=local_sql_snapshot`。

```json
{
  "booking_id": "bk_...", "order_id": "ORD...", "user_id": "u_zhang",
  "passenger": "张三", "flight_no": "MU5101", "date": "2026-11-20", "airline": "MU",
  "cabin": "Y", "fare_product": "Y", "fare": 1500, "tax": 50, "total": 1550,
  "currency": "CNY", "status": "PENDING_PAYMENT", "ticket_no": "",
  "created_at": "2026-11-18T12:00:00+00:00", "updated_at": "2026-11-18T12:00:00+00:00",
  "paid_at": null, "payment": null, "idempotent": false,
  "inventory_source": "local_sql_snapshot"
}
```

支付请求只含幂等键：

```http
POST /api/v1/bookings/bk_.../pay
{"idempotency_key":"payment-key-0001"}
```

原子迁移成功后返回 `status=ISSUED`、确定性 `ticket_no`、`paid_at`，并包含：

```json
{
  "status": "ISSUED", "ticket_no": "781-0123456789", "idempotent": false,
  "payment": {"provider":"mock","status":"SUCCEEDED",
              "idempotency_key":"payment-key-0001","real_funds":false}
}
```

同一幂等键重放返回相同订单/票号/支付时间，`idempotent=true`，不重复写支付审计或刷新投影。已出票订单换用另一键、或将同一键用于另一预订，均返回 409 `IDEMPOTENCY_CONFLICT`。订单、支付幂等记录和审计处于同一事务。这里没有真实航司出票、实时库存或真实资金扣款。

## 持久化低价监控

创建监控：

```http
POST /api/v1/watches
{"flight_no":"MU5101","date":"2026-11-20","fare_product":"Y",
 "target_total":1300,"percentage_threshold":10}
```

`target_total` 与 `percentage_threshold` 至少一项；同时配置时为 OR 关系。百分比以创建时 `baseline_total = baseline_fare + baseline_tax` 为基准，目标价也指含税总价。响应包含基线、阈值、航班、`currency=CNY`、`active=true` 和时间戳。基线与用户归属持久化在 SQL，重启不会丢失。

`POST /api/v1/watches/{watch_id}/evaluate` 每次都会新增观测，`source=manual`；可用时状态为 `OBSERVED`，取消/缺价时为 `UNAVAILABLE` 且不触发价格提醒。响应结构：

```json
{
  "watch": {"watch_id":"watch_...","baseline_total":1550,"last_evaluated_at":"2026-11-18T12:05:00+00:00"},
  "observation": {"observation_id":"obs_...","source":"manual","status":"OBSERVED",
                   "fare":1200,"tax":50,"total":1250,"currency":"CNY"},
  "alert": {"alert_id":"alert_...","trigger":"TARGET_AND_PERCENTAGE",
             "baseline_total":1550,"observed_total":1250,"drop_amount":300,
             "drop_percentage":19.35,"delivery":"dsh_history"},
  "deduplicated_alert_id": null
}
```

相同监控、触发类型和观测总价只保留一条提醒；后续观测仍保存，但 `alert=null` 且 `deduplicated_alert_id` 指向既有记录。`GET /api/v1/watches/{watch_id}` 返回最近 50 条 `observations` 与 `alerts`；`GET /api/v1/watches/alerts?limit=100` 返回当前用户全量站内历史视图（`total` 为本页条数）。

后端 worker 启动后立即评估一次有效监控，此后默认每 60 秒评估，观测 `source=scheduled`。可通过 `AEROAGENT_WATCH_INTERVAL_SECONDS` 调整（最小 1 秒）。调度只存在于后端运行期间，每条监控独立事务；失败不会中断案件与履约消费。提醒仅写入 DSH 可读的 SQL 历史，**不发送邮件、短信、推送或其他外部通知**。

## 数据迁移

迁移 `0003_order_booking_watches` 为历史订单回填 `created_at`、`updated_at`、`currency=CNY` 和空 `paid_at`，增加订单/航线索引，并创建 `booking_attempts`、`price_watches`、`price_observations`、`price_alerts`。SQLite 采用先回填再 batch 重建的方式恢复非空时间默认值；全新 `0001 → 0003` 与既有 `0002 → 0003` 均已覆盖。
