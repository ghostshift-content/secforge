# SecForge — QA Issue Tracker

Consolidated from the QA session's master register. Status is what **this repo** has
landed and self-verified; QA re-verifies independently before closing.
`[x]` fixed & verified here · `[~]` partial · `[ ]` open. Commit = where the fix landed.

Verification for the S1/S2 batch (commit 4fb7510): 23/23 unit tests; both inline
scripts parse; div balance 0; fabricated-string sweep of index.html clean; live
map/findings/memory/delete exercised against fixture-app on 127.0.0.1:4770.

## S1 · CRITICAL — fabricated security evidence
- [x] **S1-1** Findings rendered Ruby source for a JS repo → real evidence (file:line, rule, CWE, confidence). — 4fb7510
- [x] **S1-2** Fabricated Ruby remediation diff → removed; remediation hydrates from the rule (or honest empty). — 4fb7510
- [x] **S1-3** Fabricated "independent validation trail" (agents that never ran) → removed. — 4fb7510
- [x] **S1-4** Env false "Runtime validation authorised" toggle → honest static-only state. — 4fb7510
- [x] **S1-5** Env fabricated proof-of-exploit HTTP transcript → empty "no live validation" state. — 4fb7510
- [x] **S1-6** Nonexistent/`~` path "maps" successfully → mapProject errors on non-directory, `~` expanded, /map 400. — 4fb7510
- [x] **S1-7** Map subtabs fabricated (orders_controller.rb / models/user.rb / tokens.yml, 312-row inventories) → ledger from graph; inventories/roles/consolidated honest empty; coverage bars from real map. — 4fb7510
- [x] **S1-8** Assess fake run-in-progress + RLX-04/CSX-02 candidates → empty until a real run; pipeline/candidates from run. — 4fb7510
- [x] **S1-9** Memory fabricated metrics + payments-svc recall → stats from /api/memory; recall is a real query. — 4fb7510
- [x] **S1-10** SYSTEMIC "keep the designed sample" bails → every list renderer now renders real-or-empty (feature sidebar, ledger, graph, findings, candidates, coverage, memory, env, projects). — 4fb7510
- [x] **S1-11** All six tabs reachable with no project → chrome locked until a project opens; go() gates project-scoped tabs. — 4fb7510

## S2 · HIGH — dead controls
- [x] **S2-1** Env tab: real target-registration form → POST /api/projects/:id/env. — 4fb7510
- [x] **S2-2** Memory tab: real recall input → GET /api/projects/:id/memory?q=. — 4fb7510
- [x] **S2-7** Forget/delete a project → DELETE /api/projects/:id, store.deleteProject (traversal-guarded + test). — 4fb7510
- [x] **S2-8a** Feature sidebar not clickable (sample-mode bail) → renders real items with data-fid, or empty state. — 4fb7510
- [x] **S2-8b** "filter features…" was a div → removed (no fake input). — 4fb7510
- [x] **S2-8c** Project pill chevron implied a switcher → pill now shows real project / "No project"; opens launcher. — 4fb7510
- [x] **S2-9a** Findings rows unclickable in sample mode → real rows with data-fid, or empty state. — 4fb7510
- [x] **S2-9c** Fabricated acme-house-rules pattern set removed from the picker. — 4fb7510
- [x] **S2-9d** Map "phase1-maps/features/<slug>.md" file chip → real files/endpoints counts. — 4fb7510
- [x] **S2-9e** Launcher fabricated project-id chips → real project cards only. — 4fb7510
- [ ] **S2-3** Findings "Export H1" has no handler.
- [ ] **S2-4** Launcher "Engine for this session" card: inert chips (= C1).
- [ ] **S2-5** Patterns tab never fetches /api/patterns/cards; no import control (POST /api/patterns/import).
- [ ] **S2-6** No pause/resume/cancel control in the UI.
- [ ] **S2-9b** Assess: div-as-search-input; prompt-mode example chips dead; REJ chip dead.

## S3 · HIGH — data integrity
- [x] **S3-1 (N5)** stale findings served → store.clearFindings() before each scan. — 1b3ab01
- [x] **S3-2 (N3)** FSM never driven → scan starts the session; resume guarded. — 1b3ab01 *(retest after restart)*
- [x] **S3-3 (N4)** run-record engine stale → session.recordEngine() per scan. — 1b3ab01
- [x] **S3-4 (N1/N2)** engine id never validated → coerced to a known adapter id. — 1b3ab01
- [x] **S3-6** no input validation at API boundary → normaliseScope validates vs SCOPE_KINDS/RUN_METHODS. — 1b3ab01
- [ ] **S3-5** CLI adapters paint "Connected" but ask() is a no-op → make honest (rules fallback / "analysis not wired").
- [ ] **S3-7** GET /api/sessions/:id/stream 404; orchestrator.fanOut() unused → wire SSE or remove the doc claim.

## S4 · MEDIUM — wrong numbers / state
- [x] **S4-4** CWE chip 0 candidates → normaliseScope maps CWE→family. — 1b3ab01
- [x] **S4-5** engine-select race → duplicate picker removed. — 1b3ab01
- [x] **S4-6** window.state undefined → single state; model tracked. — 1b3ab01
- [x] **S4-7** no option disabled → reads connected. — 1b3ab01
- [x] **S4-8** Walkthrough step targeted #proj-acme → in-page tour retired; Walkthrough opens /demo.html. — 4fb7510
- [x] **S4-9** header pill / assess line showed acme-api@a1b2c3 → neutral until a project opens, then real. — 4fb7510
- [x] **S4-10** graph "red edge / COVERAGE_GAP" callout over a live graph → removed. — 4fb7510
- [x] **S4-11** hardcoded "Authority verified" badge → removed. — 4fb7510
- [~] **S4-1** By-feature Findings count fixed (C8); 0%-vs-100% coverage formula still to reconcile.
- [ ] **S4-2** Findings filter chips "All 12/Validated 8/Draft 4" hardcoded & unwired.
- [ ] **S4-3** Assess scope "api · 9 actions" vs feature's real endpoint count.

## Earlier cluster
- [x] C2/C3/C5 engine picker reconciled — 1b3ab01
- [x] C8 findings-per-feature id/name — 1b3ab01
- [x] C9 pattern/CWE — 1b3ab01
- [x] C10 pick mode all features — 1b3ab01
- [ ] C4/S3-5 CLI adapters "Connected" but ask() no-op
- [ ] C7/S3-7 SSE /stream + orchestrator.fanOut unwired

## S5 · LOW / hygiene
- [ ] **S5-1** No test coverage on map/assess/adapters/patterns/memory/env/routes.
- [ ] **S5-2** Dead code: coverageStub() (routes.js), hasAuthzGuard() (graph-utils.js).
- [ ] **S5-3** README "designed fallbacks" wording understates the (now removed) fabrication; revise.
