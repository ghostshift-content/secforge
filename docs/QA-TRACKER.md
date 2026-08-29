# SecForge — QA Issue Tracker

Findings raised by the QA session (secforge-7c / "QA Agent"). Status ticked as each is fixed
**and re-verified**. `[x]` fixed · `[~]` partial · `[ ]` open. Commit = where the fix landed.

## S1 · CRITICAL — fabricated security evidence (root: designed-sample fallback in the live UI)
- [x] **S1-6** nonexistent / `~` path "maps" successfully and fabricates a graph → `mapProject` now errors on a non-directory; `~` expanded; `/map` returns 400. — `da…` (this pass)
- [x] **S1-4** Env tab shows a green "Runtime validation authorised" toggle when nothing is authorised → replaced with honest static-only state, hydrated from `/api/env`.
- [x] **S1-5** Env fabricated proof-of-exploit HTTP transcript ("runtime-confirmed") → replaced with an empty "no live validation run" state.
- [x] **S1-1** Findings detail renders Ruby source for a JS repo → fabricated source block removed; real evidence (file:line, rule, cwe) shown.
- [x] **S1-2** Findings fabricated remediation diff (Ruby) → removed.
- [x] **S1-3** Findings fabricated "independent validation trail" (agents that never ran) → replaced with an honest, accurate note.
- [ ] **S1-7** Map subtabs (Feature map / Inventories / Roles / Consolidated) are fabricated sample → render real or empty state.
- [ ] **S1-8** Assess shows a fake "run in progress" + fake candidates (RLX/CSX families don't exist) before any click → clear to empty until a real run.
- [ ] **S1-9** Memory tab fabricates learning metrics + cross-project recall → render real `/api/memory` or empty.
- [ ] **S1-10** SYSTEMIC: every render bails `return; // keep sample` → delete sample fallbacks, add explicit empty states + a CI assertion that no route-backed pane contains literal sample strings.

## S2 · HIGH — dead controls (feature in docs, unreachable in UI)
- [ ] **S2-1** Env tab: no inputs/buttons; `POST /api/projects/:id/env` unreachable.
- [ ] **S2-2** Memory tab: no inputs/buttons; recall + learn unreachable.
- [ ] **S2-3** Findings "Export H1" has no handler.
- [ ] **S2-4** Launcher "Engine for this session" card: inert chips (a.k.a. original #1 / C1).
- [ ] **S2-5** Patterns tab never fetches `/api/patterns/cards`; no import control.
- [ ] **S2-6** No pause/resume/cancel control in the UI.
- [ ] **S2-7** No way to delete/forget a project.

## S3 · HIGH — data integrity  (all fixed in commit 1b3ab01)
- [x] **S3-1 (N5)** stale findings from deleted rule served → `store.clearFindings()` before each scan. — 1b3ab01
- [x] **S3-2 (N3)** FSM never driven; status stuck `created`; pause impossible → scan starts the session; resume guarded. — 1b3ab01
- [x] **S3-3 (N4)** run-record engine field stale/contradictory → `session.recordEngine()` per scan. — 1b3ab01
- [x] **S3-4 (N1/N2)** engine id never validated; bogus/object persisted → coerced to a known adapter id. — 1b3ab01

## S4 · MEDIUM — wrong numbers on screen
- [x] **S4-4** CWE chip returns 0 candidates silently → `normaliseScope` maps CWE→family. — 1b3ab01
- [x] **S4-5** engine-select race (nondeterministic labels) → duplicate picker removed. — 1b3ab01
- [x] **S4-6** `window.state` undefined → single `state`; model now tracked. — 1b3ab01
- [x] **S4-7** no option ever disabled (read `available` vs `connected`) → reads `connected`. — 1b3ab01
- [~] **S4-1** "By feature" row: Findings 0 / Coverage 0% while headline 100% → Findings count fixed (C8); the 0%-vs-100% formula mismatch still open.
- [ ] **S4-2** Findings filter chips "All 12 / Validated 8 / Draft 4" hardcoded & unwired.
- [ ] **S4-3** Assess scope "api · 9 actions" (feature has 3 endpoints).
- [ ] **S4-8** Walkthrough step 1 targets `#proj-acme`, removed once the store has projects.
- [ ] **S4-9** Header/Assess pill shows "acme-api @ a1b2c3" while another project is open.

## Earlier cluster (first two QA messages)
- [x] C2/C3/C5 engine picker reconciled — 1b3ab01
- [x] C8 findings-per-feature id/name — 1b3ab01
- [x] C9 pattern/CWE — 1b3ab01
- [x] C10 pick mode all features — 1b3ab01
- [ ] C1 dead launcher engine card (= S2-4)
- [ ] C4 CLI adapters paint "Connected" but ask() is a no-op (connection real, analysis not wired)
- [ ] C6 Env/Memory/pause routes have no UI callers (= S2-1/2/6)
- [ ] C7 SSE `/api/sessions/:id/stream` 404 + `orchestrator.fanOut` unused
- [ ] C11 no test coverage on map/assess/adapters/patterns/memory/env/routes
