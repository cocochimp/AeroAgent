# DSH Visual Workbench Design

Date: 2026-11-18
Status: Approved through interactive prototype review

## Goal

Learners use DSH as their only AeroAgent interface for the complete airline refund and change workflow. The local AeroAgent backend remains the sole source of business data, case state, quotes, and transaction execution. No fallback to the standalone task-2 web UI is required, and the default local mock model requires no DeepSeek account or API key.

## Approved Layout

The workbench uses three fixed columns:

1. **Left navigation**
   - Upper group: servicing conversation, order query, change quote, and refund quote.
   - Lower group: evaluation, policy rules, and demo data.
   - Business shortcuts operate on the currently bound order. Learning destinations replace the middle workspace while preserving the latest case context in the right inspector.
2. **Middle workspace**
   - A horizontal, scrollable order strip sits above the conversation. Selecting a card binds that order to subsequent servicing actions.
   - The DSH conversation remains the primary interaction surface. Quick prompts fill the composer rather than sending silently.
   - Structured quote fences are replaced by interactive quote cards inside the conversation.
   - Evaluation, rules, and data use the same middle workspace rather than opening a separate web application.
3. **Right execution inspector**
   - Fixed tabs: flow, retrieval, memory, and verification.
   - Shows the active case status, bound order, real trace events, retrieval funnel, memory/context data, and verification results.
   - Remains visible while learners move between business and learning views.

The visual language may follow the existing dark AeroAgent workbench, but layout and interaction take precedence over pixel-level similarity to the prototype.

## Servicing Interaction

### Order binding

Order cards use the real `GET /api/v1/orders` schema, including nested `flight` data. Selecting a card updates the bound order and inserts its `@ORDER_ID` token into the DSH composer through the host-compatible native value setter and input event. The learner explicitly sends the request.

### Quote generation

The OpenAI-compatible endpoint runs the real servicing case pipeline. It returns machine-readable case metadata plus one structured quote payload per actionable option. The client safely parses only recognized AeroAgent fences and renders all other content as ordinary host output.

Each quote card displays:

- refund or change action, order, and target flight/date when available;
- itemized fees and the correct total semantics (amount due versus expected refund);
- rule references, case id, and quote status;
- explicit confirm and decline actions.

All rendering uses DOM nodes and text content rather than injecting untrusted HTML.

### Confirmation and completion

Confirming a quote calls `POST /api/v1/quotes/{quote_id}/confirm`. A stable confirmation id and idempotency key are retained per quote so UI retries cannot create duplicate transactions.

The UI distinguishes:

- confirmation request in progress;
- `202 ACCEPTED` / transaction processing;
- completed `CHANGED` or `REFUNDED` fulfillment;
- replacement quote required;
- rejected or human-review outcomes;
- `RESULT_UNKNOWN`, which requires reconciliation and must not be retried blindly.

A successful terminal result refreshes both the case inspector and order strip. Sibling quote cards are disabled once the case enters processing or a terminal state.

Declining a quote calls the existing case-message cancellation flow with an explicit cancellation phrase. It updates the case and quote to `CANCELLED`; it does not merely remove the card.

## Conversation Continuity

Every compat assistant response that owns a case carries parseable AeroAgent case metadata. On a subsequent host request, the compat endpoint finds the latest case marker in assistant history and resumes that case instead of creating a new one.

Active-case continuation takes precedence over order-list tool delegation. Pending clarification resumes the stored agent session. Pending confirmation still requires the Quote API and cannot be bypassed by natural-language confirmation. Quote cards and inspector updates use the same case id.

## Data Flow

1. Learner selects an order and sends a servicing request in DSH.
2. DSH calls the local OpenAI-compatible endpoint.
3. The endpoint creates or resumes a case and runs `run_case_turn`.
4. The response contains readable text, case metadata, and structured quote data.
5. The zero-dependency browser ESM plugin upgrades recognized quote fences to cards and loads the case inspector from `GET /api/v1/cases/{case_id}`.
6. Explicit confirmation creates an asynchronous fulfillment operation.
7. The client follows case events with authenticated SSE parsing, using case-detail reads for consistent snapshots and terminal reconciliation.
8. Fulfillment completion updates the case, quote, and order; the client refreshes all visible representations.

No servicing rules, pricing, transaction state, or demo business data are duplicated in the browser plugin.

## Technical Boundaries

- The browser client remains dependency-free ESM and contains no bare imports.
- The DSH server plugin retains its five read-only tools. Browser confirmation uses the existing Quote API directly; it does not add a write-capable host tool.
- Add narrowly scoped CORS support for configured local DSH origins so the browser at port 3080 can call the backend at port 8000. Do not use an unrestricted wildcard origin.
- Demo tokens remain limited to the existing local `DEMO_AUTH=true` environment.
- Reuse existing case result fields (`trace`, `results`, `context`, `memory`, and `verify`) for the four inspector tabs.
- Do not add process orchestration that auto-starts the AeroAgent backend in this iteration. Learners interact only with DSH, but the documented local backend must still be running.

## Error Handling

- Backend unreachable: show an inline, actionable connection error and preserve the current conversation.
- Malformed or partial quote fence: leave host content untouched; never execute or render it as trusted HTML.
- Host DOM not ready or composer not found: retry through the existing observer without duplicate mounts.
- SSE disconnect: reconnect from the last event id and reconcile from the case detail.
- Requote: reload the case, supersede stale cards, and require a new explicit confirmation.
- Unknown transaction result: show a reconciliation state and disable automatic retry.

## Verification

1. Baseline before implementation:
   - `uv run pytest -q`: 324 passed, 1 deselected.
   - `uv run python scripts/check_docstrings.py`: passed.
   - `npm --prefix frontend test`: 12 passed.
   - `npm --prefix frontend run build`: passed.
2. Add focused backend tests for CORS, multi-turn case resume, multiple quote payloads, streaming, and confirmation-only servicing behavior.
3. Add dependency-free client tests for safe quote parsing and state transitions where practical.
4. Use ego-lite exclusively for real DSH browser verification:
   - plugin loaded with no console errors;
   - left navigation, order binding, quick prompts, and quote rendering;
   - right inspector tabs populated from real case data;
   - refund and change confirmation produce real terminal order states;
   - decline, multi-turn clarification, and failure/requote states behave correctly.
5. Re-run all backend and frontend gates before the final English commit. Commit only; do not push without an explicit user instruction.

## Documentation

Update the main README, plugin README, and DSH integration guide with the visual workbench workflow, local backend prerequisite, web-profile installation, browser verification, and limitations of the preview DSH integration.
