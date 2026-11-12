# Rule Mode Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make passenger servicing and administrator evaluation fully demonstrable with deterministic browser-only rule mode.

**Architecture:** Keep a pure TypeScript demo service behind a UI adapter. Persist demo state and evaluation cases in localStorage. Do not call the current API from demo mode. Keep Python `backend/` unchanged pending user review of the proposed `app/` layout.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, localStorage.

**Spec:** `docs/superpowers/specs/2026-11-11-rule-mode-demo-design.md`

## Global Constraints

- Rule mode must work without Docker, database, network, or LLM.
- Every ticket must show refund/change eligibility and a reason.
- A transaction only completes after a user confirmation click.
- Admin can edit, validate, save, and run the existing `id/question/expect` evaluation cases.
- Keep the requested `backend/` to `app/` source migration on hold until user review.

## Review Focus

- Unissued/changed/refunded tickets must not offer invalid repeat actions.
- Special and group fares must follow their own rules; cancelled flights use involuntary waivers.
- Invalid evaluation JSON must not overwrite the last saved dataset.
- New case actions after a completed case must not mutate the previous case record.
- Switching users must not expose another demo user's tickets or stored cases.

---

### Task 1: Deterministic demo domain and tests

**Files:** Create `frontend/src/demo/service.ts`, `frontend/src/demo/service.test.ts`; modify `frontend/package.json`, `frontend/vite.config.ts`.

- [x] Add failing tests for ticket eligibility, intent recognition, quote totals, confirmation state changes, and evaluation scoring.
- [x] Run the focused tests and confirm the expected failures.
- [x] Implement seed state, pure rule calculations, case transitions, and evaluation functions.
- [x] Run focused tests and confirm they pass.

### Task 2: Passenger rule-mode workbench

**Files:** Modify `frontend/src/api/client.ts`, `frontend/src/app/App.tsx`, `frontend/src/styles.css`.

- [x] Load demo users, orders, eligibility, and prior cases from the demo service/localStorage.
- [x] Show eligibility and reason on each ticket; allow quick actions and free-text intent.
- [x] Show matched rules, itemized quote, explicit confirmation, processing path, and result.
- [x] Display a clear simulated-data notice and never call FastAPI from this mode.

### Task 3: Administrator evaluation editor

**Files:** Create `frontend/src/app/EvaluationPanel.tsx`; modify `frontend/src/app/App.tsx`, `frontend/src/styles.css`.

- [x] Add searchable case list and editor for question/expected intent.
- [x] Validate the `id/question/expect` structure before saving to localStorage.
- [x] Run rule-mode evaluation and show totals, pass rate, and failed cases.

### Task 4: Documentation and delivery

**Files:** Modify `README.md`, `docs/api-v1.md`, `docs/runbook.md`.

- [x] Document the zero-backend rule-mode startup and admin/passenger demo steps.
- [x] Keep the pending Python package layout proposal in the design doc; do not move `backend/`.
- [x] Run frontend tests and production build, then inspect the passenger and admin flows in the desktop browser.
