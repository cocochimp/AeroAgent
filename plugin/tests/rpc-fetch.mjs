/** Node 测试用的 RPC 假网关；只验证浏览器到 Host 的方法/参数契约。 */
import assert from "node:assert/strict";

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

export function rpcFetch(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    assert.equal(url, "/api/aeroagent/rpc");
    const payload = JSON.parse(options.body || "{}");
    calls.push(payload);
    if (payload.method === "identity.setUser") {
      return response(200, { value: { user_id: payload.params.user_id } });
    }
    const handler = handlers[payload.method];
    if (!handler) return response(404, { error: { code: "UNKNOWN_METHOD", message: payload.method } });
    try {
      return response(200, { value: await handler(payload.params) });
    } catch (error) {
      return response(error.status || 500,
        { error: { code: error.code || "ERROR", message: error.message, details: error.details || {} } });
    }
  };
  const methods = () => calls.filter((call) => call.method !== "identity.setUser").map((call) => call.method);
  const params = (method) => calls.find((call) => call.method === method)?.params;
  return { calls, fetchImpl, methods, params };
}
