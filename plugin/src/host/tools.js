/** 业务工具：只暴露后端已有能力，确认与支付永远不注册为工具。 */
import { GatewayError } from "./gateway.js";

function schema(properties, required = []) {
  return { type: "object", additionalProperties: false, properties, required };
}

function summaryOf(tool, value) {
  if (!value) return `${tool}: 无数据`;
  if (tool === "aeroagent_orders") {
    if (Array.isArray(value.orders)) return `订单 ${value.orders.length} 张${value.orders[0] ? `；首张 ${value.orders[0].order_id} ${value.orders[0].status}` : ""}`;
    return `订单 ${value.order_id}：${value.status}，${value.flight_no || ""} ${value.date || ""}`;
  }
  if (tool === "aeroagent_flights") return `航班 ${value.total ?? (value.flights || []).length} 个`;
  if (tool === "aeroagent_servicing") {
    const options = value.quotes || value.options || [];
    const total = options.length ? `；${options.length} 个方案，最低 ${Math.min(...options.map((q) => Number(q.amount ?? q.total ?? 0)))} 元` : "";
    return `案件 ${value.case_id || "-"}：${value.status}${total}`;
  }
  if (tool === "aeroagent_booking") return `预订 ${value.booking_id || value.order_id || "-"}：${value.status || ""}`;
  if (tool === "aeroagent_watch") return `监控 ${(value.watches || []).length || (value.watch_id ? 1 : 0)} 条`;
  if (tool === "aeroagent_knowledge") return `规则 ${(value.rules || []).length} 条`;
  return `${tool}: 已完成`;
}

function tool(name, description, parameters, load) {
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: summaryOf(name, value) }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args = {}, exec = {}) {
      try {
        return await load(args, exec);
      } catch (error) {
        if (error instanceof GatewayError) throw new Error(`${error.code}: ${error.message}`);
        throw error;
      }
    },
  };
}

async function waitForCase(gateway, caseId, signal) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    const record = await gateway.call("cases.get", { case_id: caseId });
    if (record?.status && !["OPEN", "PROCESSING"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return gateway.call("cases.get", { case_id: caseId });
}

export function registerTools(ctx, gateway, config) {
  const disposers = [];
  disposers.push(ctx.tools.register(tool(
    "aeroagent_orders",
    "Read airline orders for the current passenger. Use action=list to search orders, action=get for one order with eligibility, action=options for 2–5 priced change alternatives.",
    schema({ action: { type: "string", enum: ["list", "get", "options"] }, order_id: { type: "string" },
      query: { type: "string" }, status: { type: "string" }, date: { type: "string" } }, ["action"]),
    async (args) => args.action === "get"
      ? gateway.call("orders.get", { order_id: args.order_id })
      : args.action === "options"
        ? gateway.call("orders.changeOptions", { order_id: args.order_id, date: args.date })
        : gateway.call("orders.list", { q: args.query, page_size: 20 }),
  )));
  disposers.push(ctx.tools.register(tool(
    "aeroagent_flights",
    "Search the local flight snapshot by origin, destination, date, cabin or flight number before creating a booking.",
    schema({ origin: { type: "string" }, dest: { type: "string" }, date: { type: "string" },
      cabin: { type: "string", enum: ["F", "C", "Y"] }, flight_no: { type: "string" } }),
    async (args) => gateway.call("flights.search", args),
  )));
  disposers.push(ctx.tools.register(tool(
    "aeroagent_servicing",
    "Operate a change/refund servicing case. action=start creates a case from the passenger's message and an order; continue resumes a case; get reads status/options; cancel cancels a waiting quote. Never confirm or pay here.",
    schema({ action: { type: "string", enum: ["start", "continue", "get", "cancel"] },
      order_id: { type: "string" }, case_id: { type: "string" }, message: { type: "string" } }, ["action"]),
    async (args, exec) => {
      if (args.action === "start") {
        const created = await gateway.call("cases.start", { order_id: args.order_id, message: args.message });
        return waitForCase(gateway, created.case_id, exec?.signal);
      }
      if (args.action === "continue") {
        await gateway.call("cases.continue", { case_id: args.case_id, message: args.message });
        return waitForCase(gateway, args.case_id, exec?.signal);
      }
      if (args.action === "get") return gateway.call("cases.get", { case_id: args.case_id });
      return gateway.call("cases.cancel", { case_id: args.case_id });
    },
  )));
  disposers.push(ctx.tools.register(tool(
    "aeroagent_booking",
    "Create a PENDING_PAYMENT booking from the local flight snapshot, or read one booking. Payment is user-only and is not available as a tool.",
    schema({ action: { type: "string", enum: ["create", "get"] }, flight_no: { type: "string" },
      date: { type: "string" }, fare_product: { type: "string" }, passenger: { type: "string" },
      booking_id: { type: "string" } }, ["action"]),
    async (args) => args.action === "get"
      ? gateway.call("bookings.get", { booking_id: args.booking_id })
      : gateway.call("bookings.create", { flight_no: args.flight_no, date: args.date,
        fare_product: args.fare_product, passenger: args.passenger }),
  )));
  disposers.push(ctx.tools.register(tool(
    "aeroagent_watch",
    "Manage price watches for the current passenger: create, list, get, evaluate, or read alerts.",
    schema({ action: { type: "string", enum: ["create", "list", "get", "evaluate", "alerts"] },
      flight_no: { type: "string" }, date: { type: "string" }, fare_product: { type: "string" },
      target_total: { type: "integer" }, percentage_threshold: { type: "number" }, watch_id: { type: "string" } }, ["action"]),
    async (args) => {
      if (args.action === "create") return gateway.call("watches.create", { flight_no: args.flight_no, date: args.date,
        fare_product: args.fare_product, target_total: args.target_total, percentage_threshold: args.percentage_threshold });
      if (args.action === "get") return gateway.call("watches.get", { watch_id: args.watch_id });
      if (args.action === "evaluate") return gateway.call("watches.evaluate", { watch_id: args.watch_id });
      if (args.action === "alerts") return gateway.call("watches.alerts", {});
      return gateway.call("watches.list", {});
    },
  )));
  disposers.push(ctx.tools.register(tool(
    "aeroagent_knowledge",
    "Read active policy rules or the latest evaluation run for explanation and quality review.",
    schema({ action: { type: "string", enum: ["rules", "evaluation"] }, query: { type: "string" },
      scenario: { type: "string" } }, ["action"]),
    async (args) => args.action === "evaluation"
      ? gateway.call("admin.evaluations", { view: "runs" })
      : gateway.call("admin.rules", { q: args.query, scenario: args.scenario }),
  )));
  if (config.enableAdminTools) {
    disposers.push(ctx.tools.register(tool(
      "aeroagent_admin",
      "Admin-only operations: switch the mock airline scenario, read scenarios, or inspect runtime config.",
      schema({ action: { type: "string", enum: ["mockScenarios", "mockSet", "config"] }, scenario: { type: "string" } }, ["action"]),
      async (args) => {
        if (args.action === "mockSet") return gateway.call("admin.mockSet", { scenario: args.scenario });
        if (args.action === "config") return gateway.call("admin.config", {});
        return gateway.call("admin.mockScenarios", {});
      },
    )));
  }
  return () => disposers.forEach((dispose) => dispose());
}
