# AeroAgent Next Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved production-shaped DSH workspace with real DeepSeek, validated intelligent mock data, complete OTA/refund/change interactions, and persistent learning/monitoring features.

**Architecture:** A classic-script DSH bootstrap loads native ESM pages from FastAPI. Existing agent, pricing, case, and transaction services remain authoritative. DeepSeek proposes and explains; backend validators and deterministic engines decide facts and amounts.

**Tech Stack:** FastAPI, SQLAlchemy/Alembic, LangGraph, DeepSeek OpenAI-compatible API, native JavaScript ESM, pytest, Node test, ego-lite.

## Global Constraints

- No API key in Git, frontend, logs, reports, or screenshots. Browser automation only ego-lite. English local commits only; never push without explicit approval.
- No silent LLM fallback, untrusted HTML injection, client-authoritative prices, cross-user access, or real airline/payment calls.
- Preserve all existing transaction invariants and tests. New APIs use `/api/v1` and update API inventory docs/tests.
- TDD: each behavior starts with a failing test and observed failure, then minimal implementation and passing verification.

---

### Task 1: Modular DSH Shell and Original Interaction Model

**Files:**
- Replace bootstrap only: `dsh-plugin-aeroagent/client.js`
- Create: `dsh-plugin-aeroagent/web/{main,router,store,api,components}.js`
- Create: `dsh-plugin-aeroagent/web/pages/{chat,orders,listing,monitor,eval,rules,data}.js`
- Create: `dsh-plugin-aeroagent/web/components/{inspector,quote-card,modal}.js`
- Create: `dsh-plugin-aeroagent/web/styles.css`
- Modify: `app/api/main.py` to serve `/dsh-ui`
- Tests: `dsh-plugin-aeroagent/*.test.mjs`

- [ ] Write loader/router/store tests for approved nav order, user isolation, stale-view cancellation, and classic-script constraints.
- [ ] Run tests and confirm missing modules fail.
- [ ] Implement the classic bootstrap and official DSH slot integration: `sidebar.brand.*`, `sidebar.panellist[.actions]`, `sidebar.workspaces`, `sidebar.footer.action`, `main`, and `sidebarRightTabs`. Do not create or hide a separate application shell; DSH retains its native sidebar/workspace/remote/right-sidebar behavior.
- [ ] Port the vanilla inspector interactions: flow expand, per-subrequest funnel, token blocks, verification/fee tables, and honest empty states.
- [ ] Implement sticky title/order strip and bottom quick actions/composer. Quick actions: query orders, generate change options, refund, change+refund.
- [ ] Implement independent orders/listing/monitor/eval/rules/data pages using existing APIs first; preserve loading/error/empty states and cancel stale views.
- [ ] Run client tests and existing frontend tests, then verify the native DSH shell and all host controls in ego-lite before committing `feat: modularize the DSH workbench shell`.

### Task 2: Real DeepSeek Routing, Security, and Date Normalization

**Files:**
- Modify: `app/config.py`, `app/adapters/outbound/llm/{factory,deepseek}.py`
- Modify: `app/adapters/inbound/http/openai_compat.py`
- Modify: `app/application/cases/service.py`, `app/application/agents/main_agent.py`
- Modify: `app/application/agents/{understanding,orchestrator}.py`
- Modify: `app/evaluation.py`
- Tests: `tests/test_{openai_compat,decision_adapters,query,evaluation}.py`, new security tests

- [ ] Add failing tests proving `aeroagent-deepseek` routes real mode, mock stays offline, unknown models fail, strict provider errors are visible, and global config is not mutated.
- [ ] Add environment key/base/model support and strict error behavior. Redact config from evaluation reports and add request throttling/call budgets.
- [ ] Thread mode through case creation/resume and reuse checkpoint mode. Infer user from selected order/user metadata instead of hardcoding `u_zhang`.
- [ ] Classify title/metadata locally before case handling; never create cases or paid calls for those requests. Capture sanitized host payloads before refining the classifier.
- [ ] Add failing date tests for `11.23`, `星期四` as clarification, year rollover, impossible dates, and Shanghai strict-future behavior. Normalize forced dates before tool schemas and show ISO+weekday in responses.
- [ ] Run targeted tests and full existing suite; commit `feat: enable secure real DeepSeek conversations`.

### Task 3: Validated SmartMock Candidates and Multi-Quote Identity

**Files:**
- Create: `app/application/smart_mock.py`
- Modify: `app/application/agents/llm.py` for bounded structured generation
- Modify: `app/application/{cases/service,pricing,agents/proposal,agents/verification}.py`
- Modify: `app/adapters/outbound/postgres/models.py` with generation metadata/migration
- Modify: compat quote serialization and DSH quote-card component
- Tests: `tests/test_{smart_mock,scheme_verify,confirmation_concurrency,issue_ticket}.py`

- [ ] Write failing tests for 2–5 candidates, schema/price/date/route violations, duplicate flight/date IDs, and provider errors.
- [ ] Implement structured candidate generation and validation; persist validated flight snapshots with source metadata.
- [ ] Extend pricing for allowed cabin/fare-product changes while preserving airline/route and all time/status rules.
- [ ] Generate each candidate quote independently by `candidate_id`. Preserve candidate/rationale metadata through requote, selection, and fulfillment.
- [ ] Generate rationale only from validated quote facts and profile ranking. Verify rationale cannot introduce unsupported price/benefit claims.
- [ ] Verify one selected candidate executes and siblings cancel, with distinct targets in confirmation tests.
- [ ] Run SmartMock and full transaction tests; commit `feat: generate validated intelligent change options`.

### Task 4: Order Search, Listing Booking, and Persistent Price Watches

**Files:**
- Modify: `app/adapters/outbound/postgres/models.py`, migrations, `app/adapters/inbound/http/orders.py`
- Create: `app/adapters/inbound/http/{flights,bookings,watches}.py`
- Create: `app/application/{booking,monitoring}.py`
- Modify: `app/worker.py`, `app/api/main.py`, `docs/api-v1.md`
- Tests: `tests/test_{orders,flights,bookings,watches}.py`

- [ ] Add failing order tests for user-scoped search, creation/departure sorting, stable pagination, and timestamp migration.
- [ ] Add order timestamps/currency and SQL-backed search/sort/pagination. Click-to-chat remains frontend-only and does not create paid calls.
- [ ] Add failing listing tests for route/date/cabin filters and unavailable flights.
- [ ] Add failing booking tests for principal ownership, server fare snapshot, `PENDING_PAYMENT`, idempotent mock payment to `ISSUED`, audit, and projection refresh.
- [ ] Implement booking attempts and Mock Payment without real inventory/funds. Never trust client prices or user IDs.
- [ ] Add failing watch tests for ownership, baseline/target/percentage thresholds, observations, and alert deduplication.
- [ ] Implement persistent watches, manual evaluation, scheduled evaluation while backend runs, and DSH alert history. No external notification claim.
- [ ] Update API inventory and run all new tests; commit `feat: add OTA booking and price monitoring`.

### Task 5: Full Learning Pages, Documentation, and Live Verification

**Files:**
- Complete DSH pages for evaluation/rules/data using current admin APIs.
- Modify: `README.md`, `dsh-plugin-aeroagent/README.md`, `docs/dsh-integration.md`, `docs/runbook.md`, `.env.example`, `config.example.json`, `/tmp/aero-watch.sh` only if needed for local run parity.

- [ ] Verify evaluation search/edit/import/export/save/run/poll/history/compare/failure drilldown.
- [ ] Verify rule filters/versioned edit/activate/deactivate/debug and data flight/profile/reset audit interactions.
- [ ] Document DeepSeek environment setup, strict errors, SmartMock validation, booking states, watch scheduling, and all mock-provider boundaries. Never include real credentials.
- [ ] Run complete backend/frontend/client gates and `git diff --check`.
- [ ] If `DEEPSEEK_API_KEY` is available, run one capped authorized live smoke proving real model participation and strict error handling. Otherwise report live verification as blocked, without substituting a mock claim.
- [ ] Use ego-lite for final DSH scenarios: multi-change selection, refund, order click, Listing booking, watch alert, user switch, and four inspector tabs.
- [ ] Request final code review, fix Critical/Important findings, and commit remaining work in English. Do not push.
