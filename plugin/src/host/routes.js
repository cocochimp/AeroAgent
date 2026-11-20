/** DSH 同源网关：浏览器只访问 /api/aeroagent/*，令牌与后端地址留在 Host。 */
import { GatewayError } from "./gateway.js";

const MAX_BODY_BYTES = 256 * 1024;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(error) {
  if (error instanceof GatewayError) {
    return json({ error: { code: error.code, message: error.message, details: error.details } },
      error.status >= 400 && error.status < 600 ? error.status : 502);
  }
  return json({ error: { code: "INTERNAL", message: error?.message || "网关内部错误", details: {} } }, 500);
}

export function registerRoutes(ctx, gateway) {
  const disposers = [];
  const rpc = ctx.connection.fetch.register({
    path: "/api/aeroagent/rpc",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) {
          return json({ error: { code: "PAYLOAD_TOO_LARGE", message: "请求体过大", details: {} } }, 413);
        }
        let payload;
        try { payload = JSON.parse(text || "{}"); } catch {
          return json({ error: { code: "INVALID_JSON", message: "请求体必须是 JSON", details: {} } }, 400);
        }
        if (typeof payload.method !== "string") {
          return json({ error: { code: "VALIDATION", message: "缺少 method", details: {} } }, 400);
        }
        const params = payload.params && typeof payload.params === "object" ? payload.params : {};
        const userId = typeof payload.userId === "string" ? payload.userId : undefined;
        const value = await gateway.call(payload.method, params, { signal: request.signal, userId });
        return json({ value });
      } catch (error) {
        return failure(error);
      }
    },
  });
  disposers.push(() => Promise.resolve(rpc).then((dispose) => dispose()));

  const events = ctx.connection.fetch.register({
    path: "/api/aeroagent/events",
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async (request) => {
      const caseId = new URL(request.url).searchParams.get("caseId");
      if (!caseId || !/^case_[A-Za-z0-9]{8,64}$/.test(caseId)) {
        return json({ error: { code: "VALIDATION", message: "caseId 不合法", details: {} } }, 400);
      }
      try {
        const upstream = await gateway.streamEvents(caseId, request.signal);
        if (!upstream.ok || !upstream.body) {
          return json({ error: { code: "UPSTREAM", message: `事件流不可用 (${upstream.status})`, details: {} } },
            upstream.status || 502);
        }
        return new Response(upstream.body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no" },
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
  disposers.push(() => Promise.resolve(events).then((dispose) => dispose()));

  const health = ctx.connection.fetch.register({
    path: "/api/aeroagent/health",
    methods: ["GET"],
    requestBody: "buffered",
    fetch: async () => {
      try {
        const meta = await gateway.call("meta.get", {});
        return json({ ok: true, meta });
      } catch (error) {
        return failure(error);
      }
    },
  });
  disposers.push(() => Promise.resolve(health).then((dispose) => dispose()));

  return () => disposers.forEach((dispose) => dispose());
}
