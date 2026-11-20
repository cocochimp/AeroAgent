/** 唯一的后端 HTTP 客户端：鉴权、超时、错误归一化与请求去重都收口在这里。 */
import { createHash, randomUUID } from "node:crypto";

export class GatewayError extends Error {
  constructor(message, { code = "GATEWAY_ERROR", status = 0, details = {} } = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const ROUTES = Object.freeze({
  "meta.get": { method: "GET", path: "/api/v1/meta" },
  "identity.setUser": { local: true },
  "orders.list": { method: "GET", path: "/api/v1/orders", query: ["q", "sort", "order", "page", "page_size"] },
  "orders.get": { method: "GET", path: ({ order_id }) => `/api/v1/orders/${encodeURIComponent(order_id)}` },
  "orders.changeOptions": { method: "GET",
    path: ({ order_id }) => `/api/v1/orders/${encodeURIComponent(order_id)}/change-options`,
    query: ["date"] },
  "flights.search": { method: "GET", path: "/api/v1/flights", query: ["origin", "dest", "date", "cabin", "flight_no"] },
  "cases.start": { method: "POST", path: "/api/v1/cases",
    body: ["message", "order_id", "client_request_id"] },
  "cases.continue": { method: "POST", path: ({ case_id }) => `/api/v1/cases/${encodeURIComponent(case_id)}/messages`,
    body: ["message"] },
  "cases.get": { method: "GET", path: ({ case_id }) => `/api/v1/cases/${encodeURIComponent(case_id)}` },
  "cases.latest": { method: "GET", path: "/api/v1/cases/latest", missingOk: true },
  "cases.list": { method: "GET", path: "/api/v1/cases", query: ["limit", "offset"] },
  "cases.cancel": { method: "POST", path: ({ case_id }) => `/api/v1/cases/${encodeURIComponent(case_id)}/cancel` },
  "quotes.confirm": { method: "POST", path: ({ quote_id }) => `/api/v1/quotes/${encodeURIComponent(quote_id)}/confirm`,
    body: ["confirmation_id", "idempotency_key", "candidate_id"] },
  "bookings.create": { method: "POST", path: "/api/v1/bookings",
    body: ["flight_no", "date", "fare_product", "passenger"] },
  "bookings.get": { method: "GET", path: ({ booking_id }) => `/api/v1/bookings/${encodeURIComponent(booking_id)}` },
  "bookings.pay": { method: "POST", path: ({ booking_id }) => `/api/v1/bookings/${encodeURIComponent(booking_id)}/pay`,
    body: ["idempotency_key"] },
  "watches.list": { method: "GET", path: "/api/v1/watches" },
  "watches.create": { method: "POST", path: "/api/v1/watches",
    body: ["flight_no", "date", "fare_product", "target_total", "percentage_threshold"] },
  "watches.get": { method: "GET", path: ({ watch_id }) => `/api/v1/watches/${encodeURIComponent(watch_id)}` },
  "watches.evaluate": { method: "POST", path: ({ watch_id }) => `/api/v1/watches/${encodeURIComponent(watch_id)}/evaluate` },
  "watches.alerts": { method: "GET", path: "/api/v1/watches/alerts" },
  "operations.get": { method: "GET", path: ({ operation_id }) => `/api/v1/operations/${encodeURIComponent(operation_id)}` },
  "operations.reconcile": { method: "POST", path: ({ operation_id }) => `/api/v1/operations/${encodeURIComponent(operation_id)}/reconcile` },
  "admin.rules": { method: "GET", path: "/api/v1/admin/rules", admin: true,
    query: ["airline", "cabin", "fare_product", "scenario", "q", "debug"] },
  "admin.ruleUpsert": { method: "PUT", path: ({ rule_id }) => `/api/v1/admin/rules/${encodeURIComponent(rule_id)}`,
    admin: true, body: ["airline", "cabin", "fare_product", "scenario", "title", "content", "active"] },
  "admin.evaluations": { method: "GET", path: "/api/v1/admin/evaluations", admin: true, query: ["view", "run_id"] },
  "admin.evaluationCases": { method: "PUT", path: "/api/v1/admin/evaluations/cases", admin: true, body: ["cases"] },
  "admin.startEvaluation": { method: "POST", path: "/api/v1/admin/evaluations/runs", admin: true,
    body: ["mode", "case_ids"] },
  "admin.config": { method: "GET", path: "/api/v1/admin/config", admin: true },
  "admin.configUpdate": { method: "PUT", path: "/api/v1/admin/config", admin: true, body: ["patch", "probe_llm"] },
  "admin.mockScenarios": { method: "GET", path: "/api/v1/admin/mock/scenarios", admin: true },
  "admin.mockSet": { method: "PUT", path: "/api/v1/admin/mock", admin: true, body: ["scenario"] },
  "admin.demoData": { method: "POST", path: "/api/v1/orders", admin: true,
    body: ["action", "flight_no", "date", "status", "delay_min", "user_id"] },
});

function pick(source, keys) {
  const out = {};
  for (const key of keys || []) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function queryString(source, keys, extra = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(extra || {})) query.set(key, String(value));
  for (const key of keys || []) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") query.set(key, String(source[key]));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export class AeroAgentGateway {
  constructor(config) {
    this.config = config;
    this.userId = config.demoUserId;
    this.startCache = new Map();
  }

  setUser(userId) {
    if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
      throw new GatewayError("用户标识不合法", { code: "VALIDATION", status: 400 });
    }
    this.userId = userId;
    return { user_id: userId };
  }

  authHeader(admin, actor = this.userId) {
    if (this.config.identityMode === "token") {
      if (!this.config.accessToken) throw new GatewayError("未配置访问令牌", { code: "AUTH_NOT_CONFIGURED" });
      return `Bearer ${this.config.accessToken}`;
    }
    return `Bearer ${admin ? "demo-admin" : "demo"}:${actor}`;
  }

  async call(method, params = {}, { signal, userId } = {}) {
    const route = ROUTES[method];
    if (!route) throw new GatewayError(`未知的 AeroAgent 方法：${method}`, { code: "UNKNOWN_METHOD", status: 400 });
    if (route.local) return this.setUser(params.user_id);
    const admin = route.admin === true;
    const actor = userId || this.userId;
    if (method === "cases.start") {
      const key = createHash("sha256").update(`${actor}|${params.order_id || ""}|${params.message || ""}`).digest("hex");
      const cached = this.startCache.get(key);
      if (cached && Date.now() - cached.at < 60000) return cached.value;
      params = { ...params, client_request_id: params.client_request_id || key.slice(0, 32) };
      const value = await this.request(route, params, admin, signal, actor);
      this.startCache.set(key, { at: Date.now(), value });
      return value;
    }
    return this.request(route, params, admin, signal, actor);
  }

  async request(route, params, admin, signal, actor) {
    const path = typeof route.path === "function" ? route.path(params) : route.path;
    const fixedQuery = route.query && !Array.isArray(route.query) ? route.query : {};
    const queryKeys = route.query && !Array.isArray(route.query) ? [] : route.query;
    const url = `${this.config.backendUrl}${path}${queryString(params, queryKeys, fixedQuery)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const timeout = new Error("timeout");
      timeout.name = "TimeoutError";
      controller.abort(timeout);
    }, this.config.requestTimeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const init = { method: route.method, signal: controller.signal,
        headers: { Authorization: this.authHeader(admin, actor), "Content-Type": "application/json",
          "X-Request-Id": randomUUID() } };
      if (route.body) init.body = JSON.stringify(pick(params, route.body));
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404 && route.missingOk) return null;
      if (!response.ok) {
        const detail = payload?.detail || payload?.error || {};
        throw new GatewayError(detail.message || `AeroAgent 后端返回 ${response.status}`,
          { code: detail.code || `HTTP_${response.status}`, status: response.status, details: detail.details || {} });
      }
      return payload;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (error?.name === "TimeoutError" || (controller.signal.aborted && controller.signal.reason?.name === "TimeoutError")) {
        throw new GatewayError("AeroAgent 请求超时", { code: "TIMEOUT" });
      }
      if (error?.name === "AbortError") throw new GatewayError("AeroAgent 请求已取消", { code: "ABORTED" });
      throw new GatewayError(`无法连接 AeroAgent 后端：${error.message}`, { code: "NETWORK_ERROR" });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async streamEvents(caseId, signal) {
    const url = `${this.config.backendUrl}/api/v1/cases/${encodeURIComponent(caseId)}/events`;
    return fetch(url, { headers: { Authorization: this.authHeader(false), Accept: "text/event-stream" }, signal });
  }
}

export { ROUTES };
