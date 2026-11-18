# AeroAgent 测试方案

四层验证，从快到慢；任何一层失败都不得进入下一层。

## 1. 确定性单元测试（秒级）

```bash
uv run pytest tests/test_query.py tests/test_scheme_verify.py tests/test_smart_mock.py -q
```

覆盖：意图识别、日期换算、规则检索、运价引擎、方案校验、金额/引用比对。
固定时钟 `AIR_NOW=2026-09-26`，不依赖外网与真实模型。

## 2. 契约与服务测试（秒级）

```bash
uv run pytest tests/test_openai_compat.py tests/test_native_e2e.py -q
```

`tests/test_native_e2e.py` 是原生会话的主回归，逐条验证：

| 用例 | 断言 |
|---|---|
| 选中客票后改签 | 返回可读方案表；案件归属与金额来自引擎 |
| 延误/取消航班 | 非自愿改签费用为 0，规则为 `GEN-*` |
| 团队票/特价票 | 明确“不得自愿改签”，不伪造报价 |
| 无订单号的追问 | 回到同一案件，不新建 |
| 换另一张客票 | 新案件归属新客票，不串用旧案 |
| 他人案件 | 统一 404 |
| 未知订单 | 404 `ORDER_NOT_FOUND`，不创建案件 |
| 内部字段 | 正文不出现 `quote_id`、JSON、案件标记 |
| 确认办理 | 202 受理 → 交易完成，案件 `COMPLETED`、报价 `EXECUTED`、订单换新票号 |
| 同幂等键重放 | 返回同一 `operation_id`，不重复出票 |

## 3. 全量后端回归

```bash
uv run pytest -q
```

要求 **0 failed**。当前 520 passed。

## 4. 客户端与真实浏览器

```bash
cd dsh-plugin-aeroagent && npm test     # 87 passed
```

浏览器验收（ego-lite，真实 DSH + 真实 DeepSeek）：

1. 品牌为飞机 + AeroAgent，导航无「退改对话」。
2. 切换到王五 → 选择客票 → 客票条显示该订单。
3. 发送改签请求 → 出现方案表，无 JSON/内部 ID。
4. 右栏自动显示本轮案件编号与 `WAITING_CONFIRMATION`。
5. 输入框上方出现「方案待确认」，二次确认后进入办理中，最终显示新票号。
6. 重复发送两次，结果一致；失败时显示可重试错误而不是 500。
7. Listing：查询航班 → 预订（`PENDING_PAYMENT`）→ 模拟支付 → `ISSUED` 并显示票号；过期航班不可预订。
8. 低价监控：创建监控 → 立即评估 → 站内提醒出现；同价再评估显示去重，不重复写提醒。

## 隔离与数据安全

- 每个测试使用独立临时库；`SessionFactory` 按当前数据库路径惰性解析，测试不会写入演示库。
- 演示库重置：删除 `var/aeroagent.db*` 后重启后端即可，订单日期相对当天生成。

## 已知边界

- 方案以结构化表格呈现；可点击的「确认办理」卡片尚未接入。
- OTA/低价监控的 4 个 Important 复审项未修，不影响退改主流程。