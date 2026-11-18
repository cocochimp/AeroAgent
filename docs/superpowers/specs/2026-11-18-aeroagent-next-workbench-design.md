# AeroAgent Next Workbench Design

Date: 2026-11-18
Status: Interaction prototype approved

## Objective

Deliver a production-shaped AeroAgent workspace inside DSH: real DeepSeek dialogue and recommendation, intelligently generated but validated mock flight/fare data, complete refund/change flows, OTA listing and mock booking, persistent low-price watches, and the original vanilla-JS workbench's rich learning interactions. Airline and payment providers remain mock; no real ticket inventory, airline, or funds are touched.

## Confirmed Product Decisions

- DeepSeek official API (`deepseek-chat`) is the only learner-facing LLM provider. API keys live only in backend environment variables and never in Git, DSH JavaScript, logs, reports, or screenshots.
- DeepSeek failures are visible and retryable; no silent mock fallback is presented as real AI.
- LLM proposes candidates and concise rationale. Backend services validate schemas and business constraints and compute final amounts deterministically.
- Change candidates preserve airline and route but may vary flight number, date, departure time, cabin, and fare product. Cross-airline replacement is refund/rebook, not ordinary change.
- Dates resolve strictly into the future using Asia/Shanghai. `M.D`, weekdays, and clarification answers are normalized to ISO before tool calls and displayed with weekday.
- Membership tier and profile affect recommendation ranking only, never fees.
- Order search defaults to creation-time descending and supports departure-date sorting. Clicking an order binds it and shows actions without auto-sending.
- Listing booking follows `PENDING_PAYMENT → mock payment → ISSUED`, with server-side fare snapshot, ownership, audit, and idempotency.
- Price watches persist in SQL, evaluate on demand and periodically while the backend runs, and notify inside DSH with deduplicated history.
- UI follows the approved prototype: unified upper-left business navigation (chat, orders, Listing, low-price watch, More), conversation history, lower-left learning navigation above the user switcher, AeroAgent airplane brand, sticky order strip, and bottom composer.

## Architecture

### DSH presentation

Replace the monolithic visual client with a small classic-script bootstrap and native ES modules served by FastAPI under `/dsh-ui`:

- `client.js`: classic-script ModuleLoader registration, stylesheet/module injection, no import/export.
- `web/main.js`: shell mount, brand, root layout, lifecycle.
- `web/router.js`: page modules, navigation ordering, stale-view cancellation.
- `web/store.js`: current user, selected order, per-user sessions, request aborts.
- `web/api.js`: JSON/SSE transport, errors, demo user tokens, idempotency keys.
- `web/components/`: safe DOM builder, inspector, quote cards, modal, timeline/funnel.
- `web/pages/`: chat, orders, listing, monitor, evaluation, rules, data.
- `web/styles.css`: DSH-compatible single-row navigation, sticky order strip, bottom composer, responsive inspector.

This preserves DSH-only usage without iframe or a second agent. Native modules provide production-shaped boundaries without adding a frontend build chain. All remote content is rendered through DOM/text nodes, not untrusted HTML strings.

### Backend boundaries

1. **Decision plane**
   - Existing `DeepSeekClient` and `DeepSeekDecisionEngine` remain the only provider integration.
   - `aeroagent-deepseek` explicitly selects internal `deepseek`; `aeroagent-mock` remains offline. Unknown model IDs fail.
   - Mode is threaded through case creation/resume without mutating global configuration or crossing users.
   - Strict mode raises provider errors for user-visible retry instead of silent rule fallback.
   - Provider/base URL/model support environment overrides. Reports use redacted configuration only.
   - Host title/metadata traffic is classified locally and never creates cases or paid calls. Compatibility endpoints gain request throttling and per-turn model-call budgets.

2. **SmartMock plane**
   - Structured candidate generation returns 2–5 proposed flights/fare profiles.
   - Validation enforces route/airline/date/field/product constraints, unique flight/date IDs, valid times, price bounds, and candidate IDs.
   - Valid candidates persist as mock flight snapshots with source metadata so fulfillment can recalculate later.
   - Pricing computes each quote independently by `candidate_id`; candidate identity is preserved through quote persistence, requote, confirmation, and fulfillment.
   - Rationale is generated from validated quote facts and profile preferences. It cannot introduce new prices, inventory, benefits, or unsupported claims.
   - Refund penalties and final refunds are computed by the existing pricing engine using current order/rule state; LLM may explain but not determine the final amount.

3. **Persistence and transactions**
   - Extend orders with creation/update timestamps and currency; migrate existing databases instead of relying on `create_all` alterations.
   - Add flight generation metadata, booking attempt/idempotency records, price watches, observations, and alert history with user ownership.
   - New booking writes target primary SQLAlchemy records, then refresh the Agent projection. No dual-write directly into the legacy projection.
   - Existing one-operation-per-case, result-unknown reconciliation, quote idempotency, sibling invalidation, and terminal SSE reconciliation remain mandatory.

4. **Identity**
   - A user catalog endpoint exposes only demo `user_id`, display name, and tier.
   - Direct APIs derive ownership from `demo:{user_id}` tokens.
   - Compat cases infer user from selected order or explicit user context, carry user metadata across turns, and never hardcode `u_zhang`.
   - Switching users aborts active streams, isolates sessions/cases/orders/watches, and never changes another user's data. Admin impersonation is not introduced.

## Interaction Specifications

### Chat

- Sticky title/order strip above an independently scrolling conversation; quick actions and composer remain fixed at the bottom.
- Quick actions: query orders, generate change options, refund, change+refund comparison.
- DeepSeek first returns normalized intent/date understanding. Ambiguous input gets clickable options, not repeated generic clarification.
- One response may contain 2–5 change cards. Each shows flight/date/time/cabin, itemized fees, total, verified rules, recommendation label, and factual rationale.
- Selecting a card opens a confirmation modal with exact quote facts and irreversible-action warning. Confirmation follows existing Quote API and asynchronous TransactionAgent state.
- Refund cards show penalty and final refund separately. Decline cancels all offers in the case. Only one alternative executes.
- Inspector ports the original vanilla interactions: expandable flow nodes, per-subrequest retrieval drilldown and rule highlighting, token/memory details, and verification/fee comparison. Empty data is never presented as successful verification.

### Orders

- SQL-backed search and sorting, creation-time descending by default, departure-date option, status filtering, and stable pagination.
- Clicking an order opens chat, binds it, and presents refund/change/detail actions without creating a case or paid call.

### Listing and booking

- Search by origin/destination/date with cabin and price/time sorting. Past/departed flights are excluded by default; cancelled flights are clearly marked.
- Booking dialog shows current user, flight, cabin, server fare/tax snapshot, and `PENDING_PAYMENT` state.
- Mock payment is idempotent and transitions to `ISSUED`; new orders appear in orders and chat after projection synchronization.

### Low-price watch

- Create route/date/cabin watches with target price and/or percentage drop, baseline, active state, and ownership.
- Manual evaluation and scheduled evaluation while the backend runs. Store observations, current minimum, last evaluation, and deduplicated alerts. No external notification claim.

### Learning and user

- Evaluation: search/edit/import/export/save/run/poll/history/compare/failure drilldown using current admin APIs.
- Rules: search/filter/versioned edit/activate/deactivate/retrieval debug using the same funnel as chat.
- Data: orders/profiles, flight status changes, profile clearing, and confirmed reset with audit.
- User menu: name+tier switching, per-user session restore, visible profile purpose, no fee effect.

## Delivery Phases

1. Modular DSH shell, sticky layout, identity, orders, and original inspector behavior.
2. Real DeepSeek routing, strict errors, date normalization, secret redaction, and request guards.
3. SmartMock candidates and rationale, multi-quote identity, refund explanations.
4. Listing booking, order timestamps/search, and low-price watches.
5. Full learning pages, documentation, live smoke, and complete regression.

Each phase has focused tests and an English local commit. No push without explicit instruction.

## Acceptance Evidence

- Real DeepSeek smoke uses a capped authorized call and proves model participation without exposing the key. If no key is available, live verification is reported as blocked rather than replaced by a false success claim.
- Change returns 2–5 distinct, correctly priced candidates with rationale; selected target is the one fulfilled.
- Refund, change, decline, requote, unknown-result, and clarification paths pass backend and DSH browser tests.
- Listing creates a pending order and mock payment issues it idempotently for the current user.
- Watch evaluation creates at most one alert for the same threshold crossing and respects user ownership.
- All existing backend/frontend/client tests plus new contracts pass. Browser automation uses ego-lite only.
