import { defineTool } from "./define-tool.js";

const BACKEND = process.env.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000";

async function getJson(path, userId, admin = false) {
  const token = admin ? `demo-admin:${userId || "u_zhang"}` : `demo:${userId || "u_zhang"}`;
  const res = await fetch(`${BACKEND}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`AeroAgent backend ${path} -> ${res.status}`);
  return res.json();
}

function textTool(name, description, parameters, load) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { text: { type: "string", required: true } },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      return { text: await load(args) };
    },
  });
}

export function apply(ctx) {
  ctx.tools.register(textTool(
    "aeroagent_list_orders",
    "List a passenger's airline orders (demo data) from the AeroAgent servicing backend.",
    { user_id: { type: "string", description: "Passenger id such as u_zhang; defaults to u_zhang." } },
    async (args) => {
      const data = await getJson("/api/v1/orders", args.user_id);
      const rows = (data.orders || []).map((o) =>
        `${o.order_id} ${o.flight_no} ${o.status} ${o.date || ""}`.trim());
      return `Orders:\n${rows.join("\n") || "(none)"}`;
    },
  ));

  ctx.tools.register(textTool(
    "aeroagent_get_case",
    "Fetch one servicing case with its quotes and current status.",
    { case_id: { type: "string", required: true, description: "Case id returned by the chat API." } },
    async (args) => JSON.stringify(await getJson(`/api/v1/cases/${args.case_id}`)),
  ));

  ctx.tools.register(textTool(
    "aeroagent_get_quote",
    "Fetch one quote by id. The backend has no standalone quote route, so the quote is read from the case detail's quotes list; case_id is required.",
    {
      quote_id: { type: "string", required: true, description: "Quote id from the case detail." },
      case_id: { type: "string", required: true, description: "Case id that owns the quote." },
    },
    async (args) => {
      const data = await getJson(`/api/v1/cases/${args.case_id}`);
      const quote = (data.quotes || []).find((q) => q.quote_id === args.quote_id);
      if (!quote) throw new Error(`Quote ${args.quote_id} not found in case ${args.case_id}`);
      return JSON.stringify({ quote, case_id: args.case_id, case_status: data.status });
    },
  ));

  ctx.tools.register(textTool(
    "aeroagent_list_rules",
    "List active refund/change policy rules currently loaded by the retrieval index.",
    {},
    async () => {
      const data = await getJson("/api/v1/admin/rules", "u_zhang", true);
      const rows = (data.rules || []).slice(0, 20).map((r) => `${r.id} ${r.airline || ""} ${r.scenario || ""}`.trim());
      return `Rules:\n${rows.join("\n") || "(none)"}`;
    },
  ));

  ctx.tools.register(textTool(
    "aeroagent_get_evaluation",
    "Fetch the latest evaluation run summary (gold-case correctness, tool accuracy).",
    {},
    async () => {
      const runs = await getJson("/api/v1/admin/evaluations?view=runs", "u_zhang", true);
      const latest = (runs.runs || [])[0];
      if (!latest) return "No evaluation runs yet.";
      const detail = await getJson(`/api/v1/admin/evaluations?view=run&run_id=${latest.run_id}`, "u_zhang", true);
      return JSON.stringify(detail).slice(0, 2000);
    },
  ));
}
