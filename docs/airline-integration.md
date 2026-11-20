# 航司接入

## 端口

```python
class AirlineGateway(Protocol):
    async def submit(self, command: dict) -> dict: ...
    async def find_by_idempotency_key(self, key: str) -> dict | None: ...
```

统一结果字段：

| 字段 | 说明 |
|---|---|
| `status` | `ACCEPTED / REJECTED / TIMEOUT / UNKNOWN` |
| `supplier_reference` | 航司回执号 |
| `ticket_no` / `pnr` | 改签成功后的新票号/记录 locator |
| `refund_amount` | 退票退款金额 |
| `code` / `message` | 拒绝或未知原因 |
| `retryable` | 是否允许人工重试 |
| `raw` | 原始响应，供审计与排障 |

## 三种实现

| 模式 | 类 | 用途 |
|---|---|---|
| `mock` | `MockAirlineGateway` | 场景化仿真：延迟、接受、拒绝、超时、票号/PNR |
| `http` | `HttpAirlineGateway` | 真实接口骨架：POST `/servicing`、GET `/servicing/{key}` |
| `cassette` | `CassetteAirlineGateway` | 回放真实样本，离线回归 |

配置：

```json
{
  "airline": {
    "mode": "http",
    "base_url": "https://airline.example.com",
    "auth_header": "Bearer ...",
    "timeout": 5,
    "cassette_dir": "demo_data/cassettes"
  }
}
```

## 场景

`demo_data/airline_scenarios.json`：

- `normal`：正常接受。
- `typhoon_delay`：航班取消，非自愿改签。
- `airline_timeout`：全部超时，演示 `RESULT_UNKNOWN` 与对账。
- `airline_reject`：可解释拒绝码。
- `price_drop`：预留场景（当前只延迟，不自动改价）。

管理端：

```bash
curl -X PUT http://127.0.0.1:8000/api/v1/admin/mock \
  -H 'Authorization: Bearer demo-admin:u_zhang' \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"airline_timeout"}'
```

## 对账

`POST /api/v1/operations/{operation_id}/reconcile` 按幂等键查询航司回执；查到后走统一结算。禁止对未知结果自动重试。

## 接真实接口的步骤

1. 实现/调整 `HttpAirlineGateway` 的字段映射与鉴权。
2. 用真实样本写 cassette，跑契约测试。
3. 切换 `airline.mode=http`，保持业务代码不变。
4. 用 `airline_timeout` / `airline_reject` 场景回归异常链路。
