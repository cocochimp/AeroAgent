# DSH Visual Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved three-column DSH workbench with order binding, interactive quotes, real asynchronous fulfillment, learning views, and live case observability.

**Architecture:** Keep AeroAgent as the only business and transaction backend. Extend the OpenAI-compatible adapter for resumable cases and structured quote responses, and evolve the dependency-free browser ESM client into the approved visual adapter without bare imports or framework dependencies.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy, pytest, browser JavaScript ESM, Node.js built-in test runner, DSH v0.1, ego-lite.

## Global Constraints

- The browser client has zero runtime dependencies and no bare imports.
- DSH server tools remain read-only; writes go only through the existing explicit Quote API or case cancellation API.
- The default model is `aeroagent-mock`; no DeepSeek account or API key is required.
- Only configured local DSH origins receive CORS access; never use `Access-Control-Allow-Origin: *` with demo authorization headers.
- Browser automation uses ego-lite only.
- Commits use English. Do not push without an explicit user instruction.
- Preserve the baseline: 324 backend tests, 12 frontend tests, docstring gate, and frontend build.

---

### Task 1: Local DSH CORS Contract

**Files:**
- Modify: `app/api/main.py`
- Test: `tests/test_dsh_cors.py`

**Interfaces:**
- Consumes: optional `AEROAGENT_DSH_ORIGINS` as a comma-separated list; defaults to `http://127.0.0.1:3080,http://localhost:3080`.
- Produces: preflight and simple-response CORS headers for configured origins, with `Authorization` and `Content-Type` allowed.

- [ ] **Step 1: Write failing CORS tests**

```python
from fastapi.testclient import TestClient
from app.api.main import app


def test_local_dsh_preflight_allows_demo_authorization():
    response = TestClient(app).options(
        "/api/v1/orders",
        headers={
            "Origin": "http://127.0.0.1:3080",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3080"
    assert "authorization" in response.headers["access-control-allow-headers"].lower()


def test_unlisted_origin_does_not_receive_cors_access():
    response = TestClient(app).get(
        "/v1/models", headers={"Origin": "https://untrusted.example"}
    )
    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers
```

- [ ] **Step 2: Run the tests and confirm the missing-CORS failure**

Run: `uv run pytest -q tests/test_dsh_cors.py`
Expected: first test fails because `access-control-allow-origin` is absent.

- [ ] **Step 3: Add narrowly scoped CORS middleware**

```python
from fastapi.middleware.cors import CORSMiddleware

_DSH_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "AEROAGENT_DSH_ORIGINS",
        "http://127.0.0.1:3080,http://localhost:3080",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_DSH_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Last-Event-ID"],
)
```

Place this after `app = FastAPI(...)` and before routers are included.

- [ ] **Step 4: Verify CORS and existing compat tests**

Run: `uv run pytest -q tests/test_dsh_cors.py tests/test_openai_compat.py`
Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/main.py tests/test_dsh_cors.py
git commit -m "feat: allow local DSH browser API access"
```

---

### Task 2: Resumable Compat Cases and Structured Quotes

**Files:**
- Modify: `app/adapters/inbound/http/openai_compat.py`
- Test: `tests/test_openai_compat.py`

**Interfaces:**
- Produces: `_latest_case_id(request: CompatRequest) -> str | None`.
- Produces: `_render_case_result(result: dict) -> str`, always emitting one `aeroagent-case` fence and one `aeroagent-quote` fence per actionable quote.
- Extends: `_run_servicing_case(message: str, case_id: str | None = None) -> dict`.
- Quote JSON keys: `quote_id`, `case_id`, `order_id`, `action`, `amount`, `currency`, `expires_at`, `fee_items`, `rule_refs`, `target`.

- [ ] **Step 1: Add failing contract tests**

```python
import asyncio
from app.adapters.inbound.http import openai_compat


def test_case_metadata_round_trips_through_assistant_history(monkeypatch):
    content = openai_compat._render_case_result({
        "case_id": "case_abc",
        "status": "NEEDS_INFORMATION",
        "clarify": {"question": "想改到哪一天？"},
    })
    assert "```aeroagent-case" in content
    assert '"case_id": "case_abc"' in content
    request = openai_compat.CompatRequest(messages=[
        {"role": "user", "content": "改签"},
        {"role": "assistant", "content": content},
        {"role": "user", "content": "后天"},
    ])
    calls = []

    async def fake_run(message, case_id=None):
        calls.append((message, case_id))
        return {"case_id": case_id, "status": "NEEDS_INFORMATION",
                "clarify": {"question": "请继续补充"}}

    monkeypatch.setattr(openai_compat, "_run_servicing_case", fake_run)
    asyncio.run(openai_compat._completion_content(request))
    assert calls == [("后天", "case_abc")]


def test_each_actionable_quote_has_its_own_fence():
    quote = {"quote_id": "q_1", "case_id": "case_abc", "order_id": "ORD1",
             "action": "REFUND", "amount": 400, "currency": "CNY",
             "expires_at": "2026-11-18T12:00:00Z", "fee_items": [],
             "rule_refs": ["R1"], "target": None}
    content = openai_compat._render_case_result({
        "case_id": "case_abc", "status": "WAITING_CONFIRMATION",
        "quotes": [quote, {**quote, "quote_id": "q_2", "action": "CHANGE"}],
    })
    assert content.count("```aeroagent-quote") == 2
    assert content.count("```aeroagent-case") == 1
```

- [ ] **Step 2: Run the new tests and verify failure**

Run: `uv run pytest -q tests/test_openai_compat.py -k "metadata or actionable"`
Expected: failure because case metadata and quote lists are not implemented.

- [ ] **Step 3: Implement case-marker parsing and quote serialization**

```python
_CASE_FENCE = re.compile(r"```aeroagent-case\s*(\{[\s\S]*?\})\s*```")


def _latest_case_id(request: CompatRequest) -> str | None:
    for message in reversed(request.messages):
        if message.role != "assistant" or not message.content:
            continue
        match = _CASE_FENCE.search(message.content)
        if match:
            try:
                case_id = json.loads(match.group(1)).get("case_id")
            except json.JSONDecodeError:
                continue
            if isinstance(case_id, str) and case_id.startswith("case_"):
                return case_id
    return None


def _case_fence(case_id: str) -> str:
    return f"```aeroagent-case\n{json.dumps({'case_id': case_id})}\n```"


def _quote_payload(row, case_id: str) -> dict:
    detail = (row.details or [{}])[0]
    pricing = detail.get("pricing") or {}
    return {
        "quote_id": row.quote_id, "case_id": case_id, "order_id": row.order_id,
        "action": row.action, "amount": row.amount, "currency": row.currency,
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "fee_items": detail.get("fee_items", []),
        "rule_refs": detail.get("rule_refs", []),
        "target": detail.get("target") or pricing.get("target"),
    }
```

- [ ] **Step 4: Resume an existing case before considering tool delegation**

```python
async def _completion_content(request: CompatRequest) -> tuple[str, list[dict] | None]:
    tool_content = _last_tool_content(request)
    if tool_content is not None:
        return f"【AeroAgent】工具返回：{tool_content[:1500]}", None
    case_id = _latest_case_id(request)
    names = _tool_names(request)
    if not case_id and "aeroagent_list_orders" in names and _ORDER_INTENT.search(_last_user(request)):
        call = [{"index": 0, "id": f"call_{uuid.uuid4().hex}", "type": "function",
                 "function": {"name": "aeroagent_list_orders",
                              "arguments": json.dumps({"user_id": "u_zhang"})}}]
        return "", call
    result = await _run_servicing_case(_last_user(request), case_id)
    return _render_case_result(result), None
```

When `_run_servicing_case` receives a case id, load that owned case, reuse its `session_id` and `order_id`, and pass `resume_payload={"value": clean}` to `run_case_turn` only when `orchestrator.pending_interrupt(session_id)` is a non-confirm interrupt. For a pending confirm interrupt, return the existing quotes with a readable instruction to use a quote card. Serialize every `OFFERED` quote into `quotes`; retain `status`, `clarify`, and `final` behavior for non-quote outcomes.

- [ ] **Step 5: Verify all compat tests and commit**

Run: `uv run pytest -q tests/test_openai_compat.py tests/test_case_trace_safety.py`
Expected: all selected tests pass.

```bash
git add app/adapters/inbound/http/openai_compat.py tests/test_openai_compat.py
git commit -m "feat: resume DSH cases and stream structured quotes"
```

---

### Task 3: Testable Client Contracts and Order/Quote Rendering

**Files:**
- Modify: `dsh-plugin-aeroagent/client.js`
- Modify: `dsh-plugin-aeroagent/package.json`
- Create: `dsh-plugin-aeroagent/client.test.mjs`

**Interfaces:**
- Produces: `parseAeroAgentQuote(text: string) -> object | null`.
- Produces: `orderView(order: object) -> object` using nested `flight` fields.
- Produces: `requestKeys(quoteId: string) -> { confirmationId: string, idempotencyKey: string }`, cached per quote.
- Browser global: `window.__AERO_CLIENT_LOADED === true` only after a successful mount.

- [ ] **Step 1: Write dependency-free failing tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { parseAeroAgentQuote, orderView, requestKeys } from "./client.js";

test("parses only valid AeroAgent quote JSON", () => {
  assert.equal(parseAeroAgentQuote("ordinary text"), null);
  assert.equal(parseAeroAgentQuote('{"quote_id":"q1"'), null);
  assert.equal(parseAeroAgentQuote('{"quote_id":"q1","case_id":"case_1","action":"REFUND"}').quote_id, "q1");
});

test("maps the real nested order response", () => {
  const view = orderView({ order_id: "ORD1", flight_no: "MU5101", status: "ISSUED",
    flight: { origin: "SHA", dest: "CAN", status: "cancelled", delay_min: 0 } });
  assert.deepEqual([view.route, view.flightStatus], ["SHA → CAN", "cancelled"]);
});

test("reuses confirmation and idempotency keys for one quote", () => {
  assert.deepEqual(requestKeys("q_stable"), requestKeys("q_stable"));
});
```

- [ ] **Step 2: Run the tests and confirm import/export failure**

Run: `node --test dsh-plugin-aeroagent/client.test.mjs`
Expected: FAIL because the named exports do not exist and the current module touches `window` at import time.

- [ ] **Step 3: Make import side-effect safe and add pure contracts**

```javascript
const BACKEND = globalThis.AEROAGENT_BACKEND_URL || "http://127.0.0.1:8000";
const keyCache = new Map();

export function parseAeroAgentQuote(text) {
  try {
    const value = JSON.parse(text.trim());
    return value && typeof value.quote_id === "string" &&
      typeof value.case_id === "string" && ["CHANGE", "REFUND"].includes(value.action)
      ? value : null;
  } catch { return null; }
}

export function orderView(order) {
  const flight = order.flight || {};
  return { ...order, route: `${flight.origin || "—"} → ${flight.dest || "—"}`,
    flightStatus: flight.status || "unknown", delayMinutes: flight.delay_min || 0 };
}

export function requestKeys(quoteId) {
  if (!keyCache.has(quoteId)) {
    const id = globalThis.crypto.randomUUID();
    keyCache.set(quoteId, { confirmationId: `confirm-${id}`, idempotencyKey: `ticket-${id}` });
  }
  return keyCache.get(quoteId);
}
```

Guard browser mounting with `if (typeof document !== "undefined" && typeof window !== "undefined")`; provide a deterministic test fallback only when `crypto.randomUUID` is unavailable.

- [ ] **Step 4: Render the approved order strip and safe quote cards**

Replace flat order fields with `orderView`. Render the fixed left navigation, middle order/conversation workspace, and right inspector from the approved design. Build quote cards with `document.createElement` and text nodes. Each recognized quote fence becomes its own card; recognized `aeroagent-case` fences are hidden after recording the active case. Never assign response JSON to `innerHTML`.

- [ ] **Step 5: Run client tests and commit**

Run: `node --test dsh-plugin-aeroagent/client.test.mjs`
Expected: all client contract tests pass.

```bash
git add dsh-plugin-aeroagent/client.js dsh-plugin-aeroagent/client.test.mjs dsh-plugin-aeroagent/package.json
git commit -m "feat: render DSH orders and interactive quote cards"
```

---

### Task 4: Learning Navigation and Live Case Inspector

**Files:**
- Modify: `dsh-plugin-aeroagent/client.js`
- Test: `dsh-plugin-aeroagent/client.test.mjs`

**Interfaces:**
- Produces: `caseView(caseRecord: object) -> { caseId, status, orderId, quotes, trace, results, context, memory, verify }`.
- Produces: `shouldStopFollowing(caseRecord: object) -> boolean` for `COMPLETED`, `CANCELLED`, `HUMAN_REVIEW`, and `RESULT_UNKNOWN`.
- Produces: authenticated SSE following with cursor resume and case-detail reconciliation.

- [ ] **Step 1: Add failing state-contract tests**

```javascript
import { caseView, shouldStopFollowing } from "./client.js";

test("maps real case observability fields", () => {
  const view = caseView({ case_id: "case_1", order_id: "ORD1", status: "COMPLETED",
    result: { trace: [{ node: "verify" }], results: [{ intent: "REFUND" }],
      context: { budget: 3000 }, memory: { turns: 2 }, verify: { passed: true } }, quotes: [] });
  assert.equal(view.orderId, "ORD1");
  assert.equal(view.trace[0].node, "verify");
  assert.equal(view.verify.passed, true);
});

test("stops only at explicit terminal or review states", () => {
  assert.equal(shouldStopFollowing({ status: "PROCESSING" }), false);
  assert.equal(shouldStopFollowing({ status: "COMPLETED" }), true);
  assert.equal(shouldStopFollowing({ status: "RESULT_UNKNOWN" }), true);
});
```

- [ ] **Step 2: Verify the new tests fail, then implement pure mappings**

Run: `node --test dsh-plugin-aeroagent/client.test.mjs`
Expected: missing exports fail.

```javascript
export function caseView(record) {
  const result = record.result || {};
  return { caseId: record.case_id, status: record.status || "UNKNOWN",
    orderId: record.order_id || null, quotes: record.quotes || [],
    trace: result.trace || [], results: result.results || [], context: result.context || {},
    memory: result.memory || {}, verify: result.verify || {}, final: result.final || {} };
}

export function shouldStopFollowing(record) {
  return ["COMPLETED", "CANCELLED", "HUMAN_REVIEW", "RESULT_UNKNOWN"].includes(record.status);
}
```

- [ ] **Step 3: Implement the four inspector tabs and learning destinations**

Populate flow, retrieval, memory, and verification from `caseView`. Left upper navigation controls business actions; lower navigation switches the middle workspace to evaluation, rules, or data using the existing backend endpoints. Keep the right inspector mounted and preserve its active case.

- [ ] **Step 4: Replace JSON fetching of SSE with authenticated stream parsing**

Use `fetch(..., { headers: { Authorization }, signal })`, `response.body.getReader()`, `TextDecoder`, double-newline block parsing, and `Last-Event-ID`/`after` cursor continuation. On `quote.offered`, `quote.revised`, `case.proposed`, `fulfillment.completed`, `fulfillment.rejected`, or `fulfillment.result_unknown`, reload the case snapshot. Stop following on explicit terminal events and `shouldStopFollowing` states.

- [ ] **Step 5: Verify contracts and commit**

Run: `node --test dsh-plugin-aeroagent/client.test.mjs`
Expected: all client tests pass.

```bash
git add dsh-plugin-aeroagent/client.js dsh-plugin-aeroagent/client.test.mjs
git commit -m "feat: add DSH learning views and case observability"
```

---

### Task 5: Real Confirmation, Decline, and Terminal Reconciliation

**Files:**
- Modify: `dsh-plugin-aeroagent/client.js`
- Test: `dsh-plugin-aeroagent/client.test.mjs`

**Interfaces:**
- Consumes: `requestKeys`, `caseView`, `shouldStopFollowing`, existing Quote API and case-message API.
- Produces: quote UI states `offered`, `confirming`, `processing`, `completed`, `cancelled`, `requote`, `failed`, and `unknown`.

- [ ] **Step 1: Test quote state transitions**

```javascript
import { quoteStateAfter } from "./client.js";

test("accepted confirmation is processing, not success", () => {
  assert.equal(quoteStateAfter("confirming", { status: "ACCEPTED" }), "processing");
  assert.equal(quoteStateAfter("processing", { status: "COMPLETED" }), "completed");
  assert.equal(quoteStateAfter("processing", { status: "RESULT_UNKNOWN" }), "unknown");
  assert.equal(quoteStateAfter("offered", { status: "CANCELLED" }), "cancelled");
});
```

- [ ] **Step 2: Confirm the test fails, then add the pure reducer**

Run: `node --test dsh-plugin-aeroagent/client.test.mjs`
Expected: missing `quoteStateAfter` export.

```javascript
export function quoteStateAfter(_current, result) {
  const status = result.status;
  if (status === "ACCEPTED" || status === "PROCESSING") return "processing";
  if (status === "COMPLETED") return "completed";
  if (status === "CANCELLED") return "cancelled";
  if (status === "REQUOTE_REQUIRED" || status === "WAITING_CONFIRMATION") return "requote";
  if (status === "RESULT_UNKNOWN") return "unknown";
  if (["FAILED", "HUMAN_REVIEW"].includes(status)) return "failed";
  return "confirming";
}
```

- [ ] **Step 3: Wire explicit buttons to real APIs**

Confirm sends the cached `requestKeys` and follows the case after `202`. Decline posts `{"message":"暂不办理"}` to `/api/v1/cases/{case_id}/messages`. On HTTP errors, parse the standard `error.message` and `error.details`; a requote loads the replacement case quote and requires a fresh click. Disable sibling cards while processing or terminal. Refresh orders only after `fulfillment.completed` or a completed case snapshot.

- [ ] **Step 4: Run all automated client/backend checks**

Run: `node --test dsh-plugin-aeroagent/client.test.mjs && uv run pytest -q tests/test_openai_compat.py tests/test_issue_ticket.py tests/test_confirmation_concurrency.py`
Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-aeroagent/client.js dsh-plugin-aeroagent/client.test.mjs
git commit -m "feat: complete DSH quote fulfillment interactions"
```

---

### Task 6: Documentation and Learner Setup

**Files:**
- Modify: `README.md`
- Modify: `dsh-plugin-aeroagent/README.md`
- Modify: `docs/dsh-integration.md`

**Interfaces:**
- Documents the approved three-column UI and local backend prerequisite.
- Documents web-profile installation, `AEROAGENT_DSH_ORIGINS`, zero-key mock usage, and real confirmation behavior.

- [ ] **Step 1: Update the DSH guide with the visual path**

Include:

```bash
DEMO_AUTH=true uv run uvicorn app.api.main:app --port 8000
npx --offline @deepseek-ai/dsh@0.1.x plugin --profile web add /Users/lovin/Desktop/AgentTest/AeroAgent/dsh-plugin-aeroagent
node --test dsh-plugin-aeroagent/client.test.mjs
```

Explain that 202 means processing, final `CHANGED`/`REFUNDED` arrives asynchronously, and `RESULT_UNKNOWN` needs reconciliation. Document the left business/learning groups and the four right inspector tabs. Keep MCP optional and read-only.

- [ ] **Step 2: Check documentation and working-tree scope**

Run: `git diff --check && git diff -- README.md dsh-plugin-aeroagent/README.md docs/dsh-integration.md`
Expected: no whitespace errors and no standalone-web fallback instructions.

- [ ] **Step 3: Commit**

```bash
git add README.md dsh-plugin-aeroagent/README.md docs/dsh-integration.md
git commit -m "docs: describe the visual DSH learner workflow"
```

---

### Task 7: Ego-Lite End-to-End Acceptance and Final Gates

**Files:**
- Modify only files required by observed failures.
- Evidence: terminal outputs and ego-lite screenshots stored outside the repository unless a documentation screenshot is explicitly desired.

**Interfaces:**
- Reuses the running backend on port 8000 and DSH web profile on port 3080.
- Verifies the complete learner workflow without a DeepSeek key or standalone web fallback.

- [ ] **Step 1: Start services and verify health**

```bash
bash /tmp/aero-watch.sh
curl -fsS http://127.0.0.1:8000/api/v1/health
curl -fsS 'http://127.0.0.1:3080/?token=eE4LgJKWwU1pWqqH00vtVMFWqRnGWN8SYSRnzKxPLgI'
```

Expected: backend healthy and DSH HTML returned. If the watcher is unavailable, start the two services separately using the repository and existing `/tmp/dsh-home` profile.

- [ ] **Step 2: Verify rendering and navigation in ego-lite**

Open the token URL in the existing ego-lite task space. Assert `window.__AERO_CLIENT_LOADED === true`, no console errors, visible left business/learning groups, order cards, and right tabs. Exercise order binding, quick prompts, evaluation/rules/data destinations, and all four inspector tabs. Capture screenshots of the initial workbench and a generated quote.

- [ ] **Step 3: Verify real refund and change transactions**

Use separate seeded orders or reset demo data between scenarios. For each action: select order, send request, confirm card, observe `PROCESSING`, and wait for a terminal result. Assert the case is `COMPLETED`, quote is `EXECUTED`, and order is `REFUNDED` or `CHANGED`. Also verify decline produces `CANCELLED` and no transaction, and a clarification follow-up retains the same case id.

- [ ] **Step 4: Run the complete final gates**

```bash
node --test dsh-plugin-aeroagent/client.test.mjs
uv run pytest -q
uv run python scripts/check_docstrings.py
npm --prefix frontend test
npm --prefix frontend run build
git diff --check
```

Expected: all tests and builds pass; backend count is at least the original 324 plus added tests.

- [ ] **Step 5: Commit remaining fixes and provide handoff**

```bash
git add app/adapters/inbound/http/openai_compat.py app/api/main.py dsh-plugin-aeroagent tests/test_openai_compat.py tests/test_dsh_cors.py README.md docs/dsh-integration.md
git commit -m "fix: align DSH workbench with live host behavior"
git status --short --branch
```

Expected: clean working tree. Report commit ids, exact test evidence, ego-lite scenarios, remaining limitations, and do not push.
