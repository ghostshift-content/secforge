# Phase 5 — Polish: honest gap analysis + design

> Status: DRAFT · Companion to `docs/SECFORGE-PLAN.md` §8 Phase 5, §5.3 · Date: 2026-08-30
>
> Phase 5 is the **final** phase. This is a YAGNI pass, not a feature-invention pass: each of
> the four bullets in `SECFORGE-PLAN.md` §8 Phase 5 is graded BUILT / worth-building /
> deliberately-NOT before any design work happens. Only the items that survive get designed.

---

## 1. Gap analysis (verdict per Phase-5 bullet)

### (a) Live progress streams — **BUILT**

`GET /api/sessions/:id/stream` (`apps/server/src/routes.js:205-236`) is a working SSE endpoint:
it plans jobs, fans them out through `@secforge/orchestrator`'s `runAll()`, and emits
`framer → hunter(×N) → triager → validator → reporter → done` events read-only, with no
persisting writer racing the stream (P0-2). Nothing to design here.

### (b) Large-scale fan-out for big repos — **already adequate, NOT building distributed/worker-pool fan-out**

Traced the actual cost path for a big repo:

1. **Ingestion is already hard-capped, honestly.** `packages/map/src/index.js:17-19` fixes
   `MAX_FILES = 25_000`, `MAX_DEPTH = 24`, `MAX_TOTAL_BYTES = 500_000_000`. Walking and reading
   stop the instant any cap is hit (`buildManifest`, lines 24-56), and the result carries a
   `truncated` flag (line 56, surfaced on the map result at line 442) — the UI is told the map is
   partial rather than silently pretending full coverage. This is the honest way to bound an
   unbounded input on a local single-user tool: degrade with a signal, don't try to out-scale it.
2. **The expensive part (reading/hashing every file) happens exactly once, at map time, and is
   capped by (1).** Everything downstream operates on the small in-memory graph that mapping
   produced, not on the file tree again.
3. **`analyze()` — the HUNT step — runs over that bounded graph, not per file.** Confirmed both
   by the code and its own comment: `packages/assess/src/index.js:17-18`, *"analyze() itself runs
   once over the whole graph; jobs exist for UI progress reporting."* The SSE stream calls
   `analyze()` once per planned job (one per feature, for progress granularity — see (a)), but
   each call is a synchronous filter/map over an already-in-memory, already-bounded array of
   graph nodes: no file I/O, no subprocess, no network call in the deterministic rules path. The
   optional LLM-assist step is separately bounded per effort level (`LLM_CAPS`,
   `packages/assess/src/index.js:65`) and per-request-timed (`LLM_TIMEOUT_MS`), so it can't runaway
   either.

**Verdict:** there is no real scale problem left for the sizes this tool targets (a single
developer's repo, capped at 25k files / 500MB). A worker-pool or distributed fan-out would add a
new process/queue model, new failure modes, and (per the self-contained/stdlib-only mandate) no
obvious stdlib primitive to build it cleanly on — for a problem the existing cap + bounded
in-memory pass already handles honestly. **Not building it.** If a future project ever needs to
map repos meaningfully larger than the current caps, the fix is to raise/tune the caps (and keep
being honest about `truncated`), not to add a fan-out subsystem — that's a one-line change,
not a design.

### (c) Scheduled consolidation — **cron is NOT worth it; on-demand + a scan-triggered hook is enough**

`consolidate()` (`packages/memory/src/index.js:184-222`) already exists, is idempotent, cheap
(exact-line dedup on `learned-patterns.md`, latest-verdict-per-key collapse on
`feedback.jsonl`), and is already reachable on demand via
`POST /api/projects/:id/memory/consolidate` (`routes.js:167-169`).

A cron/interval scheduler would need: a persistent background process (this tool has none — the
server runs only while a `secforge open` session is up, per `BACKEND-ARCHITECTURE.md` §0/§9,
"one active session per project", no daemon), new schedule-state to persist and resume, and
wall-clock-driven tests that sit awkwardly next to this codebase's deterministic-core mandate.
None of that buys anything beyond what "tidy up after the thing that dirties the files" already
gives for free, for a local single-user tool.

**Worth building (small):** call `consolidate()` automatically at the end of every scan, right
alongside the existing `minePatterns`/`annotatePriorFeedback` calls in
`POST /api/projects/:id/scan` (routes.js). This gives Phase 5's "scheduled consolidation" the
outcome it wants — `learned-patterns.md`/`feedback.jsonl` stay tidy over time — with zero new
scheduling infrastructure: it's an existing, idempotent, already-locked function invoked one more
place. **Not building:** any cron/interval/background timer.

### (d) Report exporters — **the one real gap; design below**

`window.exportFinding` (`apps/server/public/index.html:1740-1774`) is BUILT: it renders one
selected finding into a HackerOne-shaped markdown blob, entirely client-side, from
`state.selectedFinding`. It covers exactly one finding.

The decided-real gap (§5.3: "Export: HackerOne / Cobalt / generic"):

- There is **no whole-assessment report** — nothing renders *all* findings plus the coverage
  summary (`computeCoverage`'s `percent`/`matrix`/`byCwe`) and the CWE checklist
  (`cweChecklist`, `packages/assess/src/coverage.js:37-48`) into one document.
- There is **no generic/JSON export** at all — only the one markdown blob, only client-side,
  only H1-flavored, only per-finding.
- "Cobalt" as its own template is **not a real gap** — see §3.

This is the one item worth designing. See §2.

---

## 2. The worth-building set

### 2.1 Whole-assessment report builder

**Where:** `packages/assess/src/report.js` (new file), exported from `packages/assess/src/index.js`.
Not a new workspace package — the data it renders (`store.listFindings`, `computeCoverage`,
`decorateFinding`'s already-materialized fields) already lives in `@secforge/assess`, which is
where the Findings tab's data comes from per `SECFORGE-PLAN.md` §5.3. A new package would just
re-import the same two functions this one already has in scope; that's not a bounded-context
split, it's an extra `package.json` for nothing.

Findings are **already decorated** before they're written to disk (`report()` in
`packages/assess/src/index.js:207-247` calls `decorateFinding()` before `store.writeFinding()`),
so `store.listFindings(projectId)` already returns the exact shape `exportFinding` consumes —
`cvss`, `cwe_name`, `description`, `remediation`, `snippet`, `evidence`, `assessment_mode`, etc.
The report builder does **no re-derivation** of these fields — it only arranges already-real
data into a document. That is the honesty guarantee (§4): it cannot fabricate a field it never
computes.

```js
// packages/assess/src/report.js
export async function buildReport(store, projectId, format = 'md') {
  const [findings, coverage, project] = await Promise.all([
    store.listFindings(projectId),
    computeCoverage(store, projectId),
    (async () => (await store.listProjects()).find((p) => p.id === projectId) || null)(),
  ]);
  const fmt = format === 'h1' || format === 'json' ? format : 'md'; // unknown/absent → 'md' (read-only GET, safe default — same coercion style as validEffort/normaliseScope)
  if (fmt === 'json') return { contentType: 'application/json', body: JSON.stringify(reportJson(project, findings, coverage), null, 2) };
  return { contentType: 'text/markdown; charset=utf-8', body: renderMarkdown(project, findings, coverage, fmt) };
}
```

- `reportJson(project, findings, coverage)` — `{ project: {id,name,revision}, generatedAt,
  counts: {findings: findings.length, ...coverage-derived counts}, coverage, findings }`.
  `findings` is the array **verbatim** (already-decorated objects) — no filtering, no relabeling.
  Absent fields on a finding (e.g. `cvss: null` when no CVSS metadata exists for that rule) are
  already represented as real `null`s by `decorateFinding` today; the report never substitutes a
  fabricated value for one — it passes through exactly what's on disk.
- `renderMarkdown(project, findings, coverage, style)` — one function, `style` (`'h1'|'md'`)
  only changes the document's title line ("HackerOne Report" vs "Security Assessment Report");
  the body is identical either way, because the *content* must never depend on which platform
  it's headed to. Structure:

  ```
  # <H1 Report | Security Assessment Report> — <project.name>
  Generated <ISO ts> · <N> findings · coverage <coverage.percent>%

  ## Coverage summary
  - Feature × pattern-family matrix: <decided>/<total> cells decided (<percent>%)
  - CWE checklist: <assessed> assessed, <open> open, <na> n/a
  | CWE | Name | Status | Verdict/Reason |
  |...one row per coverage.cweChecklist entry...|

  ## Findings (<N>)
  ### 1. <title> — <severity>
  <exact same per-finding block shape as exportFinding(): severity/cvss line, weakness line,
   asset/route line, location line, detected-by line, assessment-mode line, Summary, Impact,
   Steps to reproduce, vulnerable-code snippet if present, Remediation if present>
  ### 2. ...

  ---
  _Exported by SecForge from project <name> · <projectId> · <N> findings · format: <style>_
  ```

  The per-finding block is a **separate, small port** of the same template `exportFinding`
  already uses in the browser (title/severity/cvss/weakness/asset/location/summary/impact/steps/
  snippet/remediation, each line only emitted when the backing field is present — same
  conditionals as the existing client code). It is not literally shared code with the browser's
  `window.exportFinding` — one is Node (renders N findings + coverage, used server-side, unit
  tested), the other is inline browser JS (renders 1 selected finding, used client-side, already
  shipped and untouched). `// ponytail: two small template copies (~30 lines each) instead of one
  shared module across the Node/browser boundary; not worth the churn unless they visibly drift —
  if that happens, extract a shared renderer then.`

- No CVSS/severity/evidence is ever invented for the report: every value it prints comes from
  a field already on the decorated finding or the coverage object. If a finding has no `cvss`
  (no `RULE_CVSS` entry for its rule — `decorateFinding`, `packages/assess/src/decorate.js:61`),
  the report omits the CVSS line rather than inventing a score, exactly like `exportFinding`
  does today.

### 2.2 Route

`GET /api/projects/:id/report?format=h1|md|json` — additive, read-only, next to the existing
`GET /api/projects/:id/findings|coverage|graph|memory|env` block in `routes.js`.

```js
if (parts[0] === 'projects' && parts.length === 3 && parts[2] === 'report' && method === 'GET') {
  const pid = parts[1];
  const proj = (await store.listProjects()).find((p) => p.id === pid);
  if (!proj) return json(res, 404, { error: 'no such project' }), true;
  const { contentType, body } = await buildReport(store, pid, url.searchParams.get('format'));
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${pid}-report.${contentType.includes('json') ? 'json' : 'md'}"`,
  });
  res.end(body);
  return true;
}
```

- Unknown/missing `format` silently defaults to `md` (same coercion posture as `validEffort` /
  `normaliseScope` elsewhere in this file) — this is a side-effect-free GET, unlike the scan
  route's explicit-scope rejection (S3-6), so there's nothing unsafe about defaulting.
- A project with zero findings/no scan yet still returns a valid, honestly-empty report (0
  findings, whatever `computeCoverage` returns for an unscanned graph) — same "not mapped yet →
  empty, not an error" posture already used by the `inventory` route (`routes.js:144-154`).
- `content-disposition: attachment` makes the response downloadable by a plain `<a href="..."
  download>` — no client-side JS needed to save the file (see §2.3).

### 2.3 UI — "Export report" control

Add three small links next to the existing per-finding "Export H1" button
(`apps/server/public/index.html:620`), scoped to the whole project rather than the selected
finding:

```html
<a id="exportReportH1" class="btn" download>Export report (H1)</a>
<a id="exportReportMd" class="btn" download>Export report (MD)</a>
<a id="exportReportJson" class="btn" download>Export report (JSON)</a>
```

Wired once the project is known (wherever `state.project` is set today):

```js
function wireReportExportLinks() {
  if (!state.project) return;
  const base = '/api/projects/' + encodeURIComponent(state.project.id) + '/report?format=';
  document.getElementById('exportReportH1').href = base + 'h1';
  document.getElementById('exportReportMd').href = base + 'md';
  document.getElementById('exportReportJson').href = base + 'json';
}
```

No fetch, no `Blob`, no `URL.createObjectURL` — the `download` attribute plus the route's
`content-disposition: attachment` header does the whole job natively (rung 4 of the ladder: a
native platform feature replaces what `exportFinding` had to build in JS, because
`exportFinding`'s content only exists client-side while the report's content is now server-
rendered and directly fetchable by URL).

**The existing per-finding `Export H1` button is unchanged** — it still exists, still does its
own thing, still client-side. This is purely additive.

---

## 3. Explicit NOT-building (YAGNI)

- **A cron/interval scheduler for consolidation.** On-demand `consolidate()` + the scan-end hook
  (§1c) already deliver "the catalog stays tidy over time"; a scheduler adds a background-process
  model this tool doesn't have, for no behavior a single local user needs. If genuine staleness
  between scans is ever reported as a real problem, add the schedule then.
- **Any distributed/worker-pool fan-out for mapping or hunting.** §1b: the bounded-graph pass
  already scales to the tool's actual input caps (25k files / 500MB / 24 deep), and the honest
  `truncated` flag is the correct behavior past that cap, not a scaling failure to fix.
- **A bespoke "Cobalt" report template.** A Cobalt write-up and a HackerOne write-up want the
  same content — CVSS/severity, weakness/CWE, asset, summary, impact, steps to reproduce,
  remediation — pasted into a different web form with different section labels. Building a third
  near-identical markdown branch to relabel headings is not new capability; the generic `md`
  format (and `json`, for anyone scripting their own upload) already serves Cobalt. If Cobalt's
  submission form is ever found to need materially different *fields* (not just headings), add a
  fourth format then — that's a real, evidence-backed reason; "the plan named it" isn't.
- **A Cobalt (or HackerOne) API uploader.** Rendering a report format is in scope; pushing it
  over a vendor's HTTP API is a new external network integration needing credentials and,
  likely, a dependency — directly against "no external deps" and "product free of any
  build-tooling reference." Out of scope, not a Phase 5 concern.
- **PDF export.** Would need a PDF-rendering library (a new dependency) or a hand-rolled PDF
  writer (a large, fragile, unrequested subsystem) for output every target here (HackerOne,
  Cobalt, a generic reader) already accepts as markdown. Not building it.
- **Anything needing a new dependency**, full stop — stdlib-only stays stdlib-only for this
  phase same as every other.

---

## 4. Honesty guarantees

- The report builder **never computes a new fact** — it only arranges fields that
  `decorateFinding()`/`computeCoverage()` already computed and already persisted to disk. It
  cannot claim a CVSS score, a CWE name, or a remediation that isn't already on the finding
  record, because it has no code path that invents one (§2.1).
- **No assessment-mode upgrade.** The report prints `finding.assessment_mode` verbatim
  (`static_confirmed` unless a real runtime validation (`packages/env`) changed it) — it never
  asserts "runtime-confirmed" for a finding that was only statically confirmed. Same rule
  `exportFinding` already follows today.
- **Counts must match reality.** The report's `<N> findings` and coverage percentages come
  directly from `store.listFindings(projectId).length` and `computeCoverage()`'s own `percent` —
  the same numbers the Findings/Assess tabs already show. A unit test (§5) asserts this: build a
  report from a known findings array and assert the printed count equals `findings.length`.
- **The ui-smoke fabrication guard keeps passing.** `apps/server/test/ui-smoke.test.js`'s
  `MARKERS` list (sample org/file/route names that must never appear in `index.html`) and its
  "no fabricated `%` next to precision/confidence/accuracy" check are untouched by this design —
  the new UI additions are three `<a>` tags with no finding/route content baked into
  `index.html`; all real content is rendered server-side from real per-project data at request
  time, never hardcoded into the shipped page.

---

## 5. API/shape + test plan

**New/changed files:**
- `packages/assess/src/report.js` — `buildReport(store, projectId, format)`, `renderMarkdown`,
  `reportJson` (internal, or exported for direct unit testing).
- `packages/assess/src/index.js` — re-export `buildReport`.
- `apps/server/src/routes.js` — one new `GET /api/projects/:id/report` branch; import
  `buildReport` from `@secforge/assess`.
- `apps/server/public/index.html` — three `<a download>` links + the small wiring function
  (§2.3). No new client-side rendering logic.

**Tests:**
1. `packages/assess/test/report.test.js` (new) — unit tests on `buildReport`/`renderMarkdown`
   against a small in-memory `store` double seeded with 2-3 known findings (one with `cvss`, one
   without) and a known `coverage` shape:
   - `md`/`h1` output contains every real finding's `id`/`title`/`cwe`, and the printed finding
     count matches `findings.length`.
   - a finding with no `cvss` produces no CVSS line (never a fabricated score).
   - `json` output round-trips (`JSON.parse`) and its `findings` array is referentially the same
     data passed in (no re-derivation, no dropped/renamed fields).
   - the coverage section's numbers match the `coverage` object passed in, not a recomputed or
     hardcoded value.
   - none of `ui-smoke.test.js`'s fabricated `MARKERS` strings appear in any rendered output
     (belt-and-suspenders: the builder should never be able to produce them either).
2. `apps/server/test/routes.test.js` (extend) — one case per format:
   - `GET /api/projects/:id/report?format=h1` → 200, `content-type` starts with `text/markdown`.
   - `?format=json` → 200, `content-type` is `application/json`, body parses.
   - `?format=bogus` (or missing) → 200, defaults to `md` (coercion, not a 400).
   - unknown project id → 404.
   - a project with no findings yet → 200, valid empty report (0 findings), not an error.
3. Re-run `apps/server/test/ui-smoke.test.js` unmodified — must stay green (§4).

**Manual/exit check:** run a scan on a real small project, hit all three `?format=` values via
`curl`, and confirm the finding count and coverage percent in each match what the Findings/Assess
tabs show for the same project.
