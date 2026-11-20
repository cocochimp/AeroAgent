"""真实航司 HTTP 适配器骨架：只做协议映射，不承载业务规则。"""
import httpx



class HttpAirlineGateway:
    """把统一退改命令映射到航司 HTTP 接口；真实字段只在这里调整。"""

    def __init__(self, *, base_url: str, auth_header: str = "", timeout: float = 5,
                 client: httpx.AsyncClient | None = None):
        if not base_url:
            raise ValueError("airline.base_url 未配置")
        self.base_url = base_url.rstrip("/")
        self.auth_header = auth_header
        self.timeout = timeout
        self._client = client

    def _headers(self, key: str) -> dict:
        headers = {"Content-Type": "application/json", "Idempotency-Key": key}
        if self.auth_header:
            headers["Authorization"] = self.auth_header
        return headers

    @staticmethod
    def _normalize(payload: dict, status_code: int, key: str) -> dict:
        status = str(payload.get("status", "")).upper()
        if status in {"ACCEPTED", "REJECTED", "TIMEOUT", "UNKNOWN"}:
            result = {"status": status, "supplier_reference": payload.get("supplier_reference"),
                      "raw": payload, "retryable": status in {"TIMEOUT", "UNKNOWN"}}
            if status == "REJECTED":
                result.update(code=payload.get("code", "SUPPLIER_REJECTED"),
                              message=payload.get("message", "航司拒绝办理"))
        elif 200 <= status_code < 300:
            result = {"status": "ACCEPTED", "supplier_reference": payload.get("supplier_reference"),
                      "raw": payload, "retryable": False}
        elif status_code == 409:
            result = {"status": "REJECTED", "code": payload.get("code", "SUPPLIER_REJECTED"),
                      "message": payload.get("message", "航司拒绝办理"), "raw": payload, "retryable": False}
        else:
            result = {"status": "UNKNOWN", "code": payload.get("code", f"HTTP_{status_code}"),
                      "message": payload.get("message", "航司返回未知结果"), "raw": payload, "retryable": True}
        if result["status"] == "ACCEPTED":
            # 真实票号/PNR 只能来自航司；缺失时不能伪造成功。
            if payload.get("ticket_no") is not None:
                result["ticket_no"] = payload["ticket_no"]
            if payload.get("pnr") is not None:
                result["pnr"] = payload["pnr"]
            if payload.get("refund_amount") is not None:
                result["refund_amount"] = int(payload["refund_amount"])
        return result

    async def submit(self, command: dict) -> dict:
        """提交退改命令并把航司响应映射为统一结果。"""
        key = command["idempotency_key"]
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            response = await client.post(f"{self.base_url}/servicing", json=command,
                                         headers=self._headers(key))
            try:
                payload = response.json() if response.content else {}
            except ValueError:
                return {"status": "UNKNOWN", "code": "SUPPLIER_INVALID_JSON",
                        "message": "航司返回内容不是合法 JSON", "retryable": True, "idempotent": False}
            result = self._normalize(payload, response.status_code, key)
            if command.get("action") == "CHANGE" and result["status"] == "ACCEPTED" and not result.get("ticket_no"):
                return {"status": "UNKNOWN", "code": "MISSING_TICKET_NO",
                        "message": "航司已受理但未返回新票号", "retryable": True, "idempotent": False,
                        "raw": payload}
            result["idempotent"] = False
            return result
        except httpx.TimeoutException:
            return {"status": "TIMEOUT", "code": "SUPPLIER_TIMEOUT",
                    "message": "航司响应超时，办理结果待核对", "retryable": True, "idempotent": False}
        except (httpx.HTTPError, ValueError) as exc:
            return {"status": "UNKNOWN", "code": "SUPPLIER_UNAVAILABLE", "message": str(exc),
                    "retryable": True, "idempotent": False}
        finally:
            if self._client is None:
                await client.aclose()

    async def find_by_idempotency_key(self, key: str) -> dict | None:
        """按幂等键查询航司办理结果，供超时对账。"""
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            response = await client.get(f"{self.base_url}/servicing/{key}", headers=self._headers(key))
            if response.status_code == 404:
                return None
            if response.status_code >= 400:
                return {"status": "UNKNOWN", "code": f"HTTP_{response.status_code}",
                        "message": "航司状态查询失败", "retryable": True}
            try:
                return self._normalize(response.json(), response.status_code, key)
            except ValueError:
                return {"status": "UNKNOWN", "code": "SUPPLIER_INVALID_JSON",
                        "message": "航司状态内容不是合法 JSON", "retryable": True}
        except httpx.HTTPError as exc:
            return {"status": "UNKNOWN", "code": "SUPPLIER_UNAVAILABLE", "message": str(exc),
                    "retryable": True}
        finally:
            if self._client is None:
                await client.aclose()
