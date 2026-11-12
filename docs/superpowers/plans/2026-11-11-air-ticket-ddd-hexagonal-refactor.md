# Air Ticket DDD Hexagonal Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the demo into a modular air-ticket servicing application with DDD hexagonal boundaries, no more than 15 versioned FastAPI routes, a React operator UI, and production-oriented persistence, queueing, evaluation, tracing, deployment, and security seams.

**Architecture:** Keep a modular monolith. Domain and application code own servicing decisions; inbound FastAPI and React are adapters; PostgreSQL is the business source of truth; Redis Streams handles asynchronous work and cross-process events; Qdrant/BM25 assist policy discovery. LangGraph controls three permission-separated Agents.

**Tech Stack:** Python 3.13, FastAPI, LangGraph, SQLAlchemy async, PostgreSQL, Redis Streams, Qdrant, BM25/RRF, React 18, Vite, TypeScript, Docker Compose, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-11-11-air-ticket-agent-business-hardening-design.md`

## Global Constraints

- Preserve the current fake-airline boundary; do not claim live GDS, payment, or airline integration.
- A user identity comes from a verified server-side principal, never a request-supplied `user_id`.
- Transaction writes require an explicit confirmation bound to quote, amount, operation, and idempotency key.
- An expired quote already confirmed by the user is revalidated; a decrease or increase up to 1% proceeds at the confirmed amount; an increase above 1% requires a new confirmation.
- Keep the public/admin HTTP route inventory at 15 method/path pairs maximum.
- PostgreSQL is authoritative for cases, quotes, operations, and ledger; Redis is never the financial source of truth.
- Fit visual implementation to the existing workflow UI and taste-skill design checks; avoid a marketing landing page treatment.
- Keep `.archify/` and the approved untracked design document intact.

## Review Focus

- Replayed confirmation or retry after timeout must not issue a second airline action: persist a unique idempotency key with the operation.
- A confirmed quote that expires must still follow the 1% rule; an increase above 1% must not reach the transaction adapter.
- A user cannot read another user's order or case by changing a path or query parameter: bind reads and writes to the verified principal.
- A worker crash between database commit and Redis publish must not lose a committed transaction: persist an outbox event in the same database transaction.
- Redis/Qdrant/LLM unavailability must degrade to clear retry/human paths; never invent a policy or financial amount.

---

### Task 1: Establish DDD hexagonal boundaries

**Files:**
- Create: `backend/app/domain/{ticket,policy,servicing,pricing,finance,loyalty,fulfillment}/`
- Create: `backend/app/application/{cases,ports,agents,orchestration}/`
- Create: `backend/app/adapters/{inbound/http,outbound}/`
- Create: `backend/app/composition.py`
- Modify: `pyproject.toml`

**Interfaces:**
- Domain packages contain entities/value objects/services only and import no FastAPI, LangGraph, SQLAlchemy, Redis, or provider SDKs.
- Application ports define repository, airline, LLM, event, and trace interfaces.
- `composition.py` is the sole production dependency-wiring root for API and worker.

- [ ] Move or wrap current stable fare, rule, and retrieval functions behind application ports without changing their monetary semantics.
- [ ] Make the CLI compatibility path import the same domain/application services.
- [ ] Keep public package imports stable where existing scripts require them.

### Task 2: Implement quote protection, case, operation, and ledger domain

**Files:**
- Create: `backend/app/domain/pricing/{quote.py,price_review.py}`
- Create: `backend/app/domain/servicing/{case.py,state.py}`
- Create: `backend/app/domain/fulfillment/{operation.py,idempotency.py}`
- Create: `backend/app/domain/finance/{ledger.py,money.py}`
- Create: `backend/app/domain/loyalty/{tier.py,benefit.py}`

**Interfaces:**
- `review_confirmed_quote(confirmed_amount: int, current_amount: int) -> PriceReview` returns `PROCEED_AT_CONFIRMED`, `REQUOTE_REQUIRED`, or `INVALID_AMOUNT`.
- `Quote` stores quote ID, case/order/action, itemized amounts, amount due, currency, expiry, policy/benefit versions, and immutable confirmation data.
- `Operation` stores unique idempotency key, quote ID, status, supplier request/result, and reconciliation state.

- [ ] Encode the exact 1% threshold with integer amounts using cross multiplication (`current * 100 <= confirmed * 101`) and an inclusive boundary; do not use floats.
- [ ] Ensure lower prices and increases within 1% preserve the confirmed customer amount; record platform variance.
- [ ] Ensure decreases in a refund amount are not auto-executed without reconfirmation.
- [ ] Enforce allowed case and operation state transitions; terminal outcomes cannot transition back to pending.

### Task 3: Add PostgreSQL persistence and transactional outbox

**Files:**
- Create: `backend/app/adapters/outbound/postgres/{models.py,repositories.py,unit_of_work.py}`
- Create: `backend/app/adapters/outbound/outbox/{publisher.py,worker.py}`
- Create: `backend/migrations/`
- Create: `backend/app/adapters/outbound/redis/{streams.py,event_bus.py}`
- Modify: `pyproject.toml`, `uv.lock`

**Interfaces:**
- Repositories implement application ports for order, rule, case, quote, operation, ledger, and audit records.
- `UnitOfWork` commits operation, ledger, and outbox rows atomically.
- Redis Streams consumers acknowledge only after durable result recording; failures retry finitely then enter a dead-letter stream.

- [ ] Persist seed users/orders/flights/rules in PostgreSQL and keep deterministic seed/reset behavior in local scripts.
- [ ] Persist LangGraph checkpoints in durable storage using the supported PostgreSQL checkpointer adapter.
- [ ] Add version-keyed rule cache only; do not cache quote or ledger truth.
- [ ] Make confirmation idempotency durable with a PostgreSQL unique constraint, Redis only as an optional short-lived guard.

### Task 4: Split workflow into the three permission-separated Agents

**Files:**
- Create: `backend/app/application/agents/{main_agent.py,solution_agent.py,transaction_agent.py}`
- Create: `backend/app/application/orchestration/{graph.py,state.py,nodes.py}`
- Modify: current `air_agent/graph.py`, `air_agent/tools.py` or their compatibility adapters.

**Interfaces:**
- Main Agent classifies intent, resolves the authenticated order, and delegates only.
- Solution Agent has read-only order/policy/flight/pricing query tools; deterministic domain services decide eligibility and amounts.
- Transaction Agent accepts only `ConfirmedQuoteCommand(quote_id, confirmation_id, idempotency_key)` and cannot change price or action.

- [ ] Preserve clarification and confirmation as resumable graph interrupts.
- [ ] Revalidate confirmed quotes even after quote expiry and branch above 1% to a new quote before any write tool is available.
- [ ] Route supplier timeout to operation reconciliation; never blindly retry a non-idempotent supplier action.

### Task 5: Replace legacy HTTP surface with 15 versioned API routes

**Files:**
- Create: `backend/app/adapters/inbound/http/{cases.py,orders.py,rules.py,evaluations.py,config.py,health.py,auth.py}`
- Create: `backend/app/api/{schemas.py,errors.py,main.py}`
- Modify: `app.py`, `start.sh`

**Interfaces:**
- Implement exactly the 15 method/path pairs in the approved spec's “API 收敛目标” table.
- Case creation returns a `case_id`; messages resume the graph; case events stream SSE.
- `POST /api/v1/quotes/{quote_id}/confirm` returns `REQUOTE_REQUIRED` for increases above 1% and does not invoke fulfillment.
- Orders and cases derive `user_id` from authenticated principal; admin routes require admin role.

- [ ] Replace old `/api/*` routes rather than leaving uncounted aliases active.
- [ ] Move demo reset and flight simulation controls to `scripts/demo.py`.
- [ ] Consolidate LLM connectivity probe into `PUT /api/v1/admin/config` as described by the spec.
- [ ] Apply consistent error envelopes and safe redaction for internal exceptions.

### Task 6: Build React workflow UI in the taste-skill design system

**Files:**
- Create: `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`
- Create: `frontend/src/{app,features,components,design-system,api}/`
- Create: `frontend/index.html`
- Retire: `web/` after the React screens cover the user/admin flows.

**Interfaces:**
- `api/` contains typed clients for the 15 routes and a reconnect-safe SSE subscription.
- `features/servicing` covers order selection, intent, quote breakdown, confirmation, and case status.
- `features/admin` covers rules, eval runs, and config.

- [ ] Use React 18, Vite, TypeScript, shared design tokens, keyboard-accessible controls, explicit loading/empty/error states, and reduced-motion support.
- [ ] Apply taste-skill to the operational product UI; keep fee, airline/platform split, and reconfirmation state visually explicit.
- [ ] Remove decorative dashboard noise; prioritize one primary action per view and align content widths/spacing.

### Task 7: Complete Eval, Trace, Deploy, and Security foundations

**Files:**
- Create: `eval/`, `infra/docker-compose.yml`, `Dockerfile`, `.env.example`
- Create: `backend/app/adapters/outbound/telemetry/`
- Modify: `README.md`, `.gitignore`

- [ ] Track step-level eval metrics for intent/order selection, tool and parameters, policy applicability, amount, confirmation gate, and fulfillment outcome.
- [ ] Add independent reviewed financial gold data; do not generate expected financial truth from the engine under evaluation.
- [ ] Emit OpenTelemetry spans across API, graph, Agent, retrieval, LLM, PostgreSQL, Redis, and airline adapter; redact PII and credentials.
- [ ] Compose API, worker, PostgreSQL, Redis, Qdrant, and frontend with health/readiness configuration and secret injection.
- [ ] Record auth, quote confirmation, operation, ledger variance, and admin rule/config changes in audit records.

### Task 8: Update project entry points and documentation

**Files:**
- Modify: `README.md`, `start.sh`, `pyproject.toml`
- Create: `docs/api-v1.md`, `docs/runbook.md`

- [ ] Document the 15 public routes, auth model, local Compose startup, demo scripts, architecture boundaries, and external-system simulation limits.
- [ ] Make `start.sh` point to the new API/frontend compose path while retaining a documented CLI mode.
- [ ] Mark current implementation capabilities separately from planned/disabled production integrations.
