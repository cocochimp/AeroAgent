# 演示脚本

## 准备

```bash
uv sync
uv run uvicorn app.api.main:app --port 8000
dsh plugin --profile web add /absolute/path/AeroAgent/plugin
```

打开 DSH，确认左侧出现 AeroAgent 导航。

## 1. 改签（3 分钟）

1. 我的订单 → 选 `ORD...001`（MU5101，两天后；误机单 `ORD...010` 也可演示，但按 after 档计费）。
2. 对话输入：`帮我改签到后天，请生成可选方案，并说明差价和手续费。`
3. 看报价卡：方案、费用明细、规则依据、合计。
4. 点“确认办理” → 办理中 → 新票号。
5. 右侧观测：流程、检索、记忆、校验、航司回执。

## 2. 退票

1. 切换演示用户到王五，选 `ORD...007`（MU5121 已取消）。
2. 输入：`航班取消了，请按票规计算退票费和最终退款。`
3. 确认 → 退款金额。

## 3. 多方案改签

在对话里要求“多方案改签”（Agent 调 `aeroagent_orders action=options`），或直接调 `GET /api/v1/orders/{id}/change-options`，展示 2–5 个候选、推荐理由与价格排序。

## 4. 预订 + 支付

1. Listing → 选航线/日期/舱位。
2. 创建预订 → 状态 `PENDING_PAYMENT`。
3. 点支付 → `ISSUED`，订单页出现。

## 5. 低价监控

1. 低价监控 → 新建监控。
2. 手动评估 → 提醒列表出现。

## 6. 异常与对账

1. 更多功能 → 仿真航司 → 切到“航司超时”。
2. 走一次改签确认 → 案件 `RESULT_UNKNOWN`。
3. 切回“正常办理” → 在报价卡或右侧「回执」页点“核对结果” → 对账完成。

## 验收清单

- [ ] `window.__AERO_CLIENT_LOADED === true`
- [ ] 无 console error / slot crash
- [ ] 改签、退票、预订支付、监控四条链路
- [ ] 确认按钮只在 UI，工具列表无 confirm/pay
- [ ] 灯光/暗色、窄屏、键盘焦点
- [ ] 后端停止时显示启动命令
