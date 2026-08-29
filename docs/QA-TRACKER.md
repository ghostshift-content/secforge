# SecForge — QA Issue Tracker

Consolidated from the QA session's master register. Status is what **this repo** has
landed and self-verified; QA re-verifies independently before closing.
`[x]` fixed & verified here · `[~]` partial · `[ ]` open. Commit = where the fix landed.

Status as of commit 0b0b0b7: all S1, all S3, all S4, S5-2/S5-3, and every S2 item
are landed; S5-1 is partial (assess/map covered, other packages thin). Verified:
34/34 unit tests; both inline scripts parse; div balance 0; fabricated-string sweep
of index.html clean; live map/findings/memory/delete/SSE-stream exercised against
fixture-app on 127.0.0.1:4770.

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
- [x] **S2-3** Findings "Export H1" → exports the selected finding as a HackerOne-style markdown report. — 5a7f807/e64ad56
- [x] **S2-4** Launcher engine card → real #engineSelectLauncher wired to the authoritative picker. — e64ad56
- [x] **S2-5** Patterns → detail pane lists real cards from /api/patterns/cards; import control POSTs /api/patterns/import. — 5a7f807/e64ad56
- [x] **S2-6** Pause/Resume/Cancel controls in the Assess panel → /api/sessions/:id/(pause|resume|cancel). — e64ad56
- [x] **S2-9b** Prompt-mode example chips fill the ask box + enable prompt mode; the multiselect search is a real input (was already); REJ chip removed with the fake candidate list. — 5a7f807

## S3 · HIGH — data integrity
- [x] **S3-1 (N5)** stale findings served → store.clearFindings() before each scan. — 1b3ab01
- [x] **S3-2 (N3)** FSM never driven → scan starts the session; resume guarded. — 1b3ab01 *(retest after restart)*
- [x] **S3-3 (N4)** run-record engine stale → session.recordEngine() per scan. — 1b3ab01
- [x] **S3-4 (N1/N2)** engine id never validated → coerced to a known adapter id. — 1b3ab01
- [x] **S3-6** no input validation at API boundary → normaliseScope validates vs SCOPE_KINDS/RUN_METHODS. — 1b3ab01
- [x] **S3-5** CLI adapters "Connected" but ask() no-op → adapters carry a truthful `analysis` field; picker shows "Connected · analysis not wired" + disables the model for rules-only providers. — 0b0b0b7
- [x] **S3-7** /stream 404 + fanOut unused → real deterministic SSE endpoint fans out via orchestrator.runAll; UI consumes it for live progress. — 0b0b0b7

## S4 · MEDIUM — wrong numbers / state
- [x] **S4-4** CWE chip 0 candidates → normaliseScope maps CWE→family. — 1b3ab01
- [x] **S4-5** engine-select race → duplicate picker removed. — 1b3ab01
- [x] **S4-6** window.state undefined → single state; model tracked. — 1b3ab01
- [x] **S4-7** no option disabled → reads connected. — 1b3ab01
- [x] **S4-8** Walkthrough step targeted #proj-acme → in-page tour retired; Walkthrough opens /demo.html. — 4fb7510
- [x] **S4-9** header pill / assess line showed acme-api@a1b2c3 → neutral until a project opens, then real. — 4fb7510
- [x] **S4-10** graph "red edge / COVERAGE_GAP" callout over a live graph → removed. — 4fb7510
- [x] **S4-11** hardcoded "Authority verified" badge → removed. — 4fb7510
- [x] **S4-1** By-feature "Coverage" column renamed "Pass rate" (assessed pass share) so it no longer collides with map-completeness. — a4f5889
- [x] **S4-2** Findings filter chips → real, clickable severity filters with live counts. — 5a7f807
- [x] **S4-3** Assess per-feature scope label shows the feature's real endpoint+job count; "all" from updateScopeLabels. — 5a7f807

## Earlier cluster
- [x] C2/C3/C5 engine picker reconciled — 1b3ab01
- [x] C8 findings-per-feature id/name — 1b3ab01
- [x] C9 pattern/CWE — 1b3ab01
- [x] C10 pick mode all features — 1b3ab01
- [x] C4/S3-5 CLI adapters "Connected" but ask() no-op — 0b0b0b7
- [x] C7/S3-7 SSE /stream + orchestrator.fanOut unwired — 0b0b0b7

## Round 2 — QA regression (8 open + 3 new + S6), against ef8895f
QA withdrew the "47 dead controls" figure: 0 dead of 110 actionable controls.
- [x] **S2-8b** "filter features" is now a real input that live-filters the feature sidebar. — 3241ad9
- [x] **S2-8c** Project pill is a real switcher (dropdown of projects + "Open another…"). — 3241ad9
- [x] **S4-1** By-feature pass rate uses the same decided/total denominator as the headline. — 3241ad9
- [x] **S4-10** Removed the "Coverage gap" legend entry (no COVERAGE_GAP nodes are emitted). — 3241ad9
- [x] **N-3** WIRING.md corrected (Validate-live / Env / patterns cards+import are built, not "planned"). — 3241ad9
- [x] **N-2** Memory search already fires on Enter (`onkeydown` at the input) + Recall button — verified present. — (prior)
- [x] **S4-8** In-page tour retired (STEPS=[], Walkthrough → /demo.html); `#proj-acme` exists only in demo.html (the intentional designed mock). — (prior)
- [~] **N-1** Pattern cards are clickable → detail pane (UI done, 3241ad9); card BODIES on the wire pending backend re-vendor of /api/patterns/cards.
- [~] **S6** Finding detail renders CVSS/CWE-name/description/snippet/remediation when present (UI done, 3241ad9); the enriched finding RECORD (cvss, cwe_name, description, remediation, snippet, severity-from-CVSS) pending backend.
- [ ] **S3-6** Invalid scope.mode/method should 400 (not silently coerce) — backend, in progress.
- [ ] **S4-3** Re-confirm scope action count (QA blocked: single-feature fixture).

## S5 · LOW / hygiene
- [~] **S5-1** +11 tests added for packages/assess (rules + computeCoverage) and packages/map (ERROR/MAPPED); 34/34 pass. Adapters/patterns/memory/env/routes still thin. — 0b0b0b7
- [x] **S5-2** Removed coverageStub() (routes.js) and hasAuthzGuard()+AUTHZ_EDGE_TYPES (graph-utils.js). — 0b0b0b7
- [x] **S5-3** README status revised — every pane renders real data or an explicit empty state; tabs lock until a project opens. — a4f5889
