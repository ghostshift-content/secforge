# Phase 2 (Assess) — Honest Gap Analysis & Depth Design

> Status: DESIGN ONLY — no code changed by this doc.
> Scope: `docs/SECFORGE-PLAN.md §5.2` (Assess tab pipeline) and `docs/BACKEND-ARCHITECTURE.md §4/§1`
> (scan-session flow, executor→verifier separation), checked against what
> `packages/assess`, `packages/orchestrator`, `packages/agents`, and `apps/server` actually do today.

## 0. Headline finding

**The executor→verifier rule is violated today, and it's not a corner case.** In
`packages/assess/src/rules.js`:

```js
export function validateCandidate(candidate, graph) {
  const idx = indexGraph(graph);
  const fn = REVERIFY[candidate.rule];
  return fn ? fn(candidate, idx) : true;   // ← unknown rule id defaults to PASS
}
```

Every LLM-assist candidate is tagged `rule: 'llm'` (`index.js` `parseLlmCandidates`). `'llm'` is
never a key in `REVERIFY` (which only has the 4 deterministic rule ids), so `fn` is `undefined`
and the function returns `true` **unconditionally** for every LLM-sourced candidate. It then gets
`verified: true` and, in `findingOf()`, a hardcoded `verification: 'verified'`.

Concretely, with a working LLM adapter, SecForge can today report a **"verified" SQL-injection or
SSRF finding (QIX/SX) that no deterministic rule has ever checked** — `rules.js` has zero rules for
those families — purely because the model's prose parsed into a candidate naming a real route. This
is exactly the failure mode §5.2 and BACKEND-ARCHITECTURE §1 name and forbid ("a validator...
cannot validate its own work"). It is the one thing in this doc that must be fixed; everything else
is comparatively minor.

---

## 1. Gap analysis table

| §5.2 element | Verdict | Evidence |
|---|---|---|
| **Question-framer** (scope → bounded job envelope) | **BUILT** | `planJobs()` (`index.js:19`) turns `scope.{mode,features,method,patterns,prompt}` into `jobEnvelope`s per feature×pattern; `analyze()`'s `inScope`/`familyAllowed` (`rules.js:143-162`) enforce the bound deterministically. Full-scan and single-feature/pick modes are both real. |
| ...but: prompt-mode fidelity into the LLM step | **PARTIAL (not fixed here)** | `scope.prompt` (free-text targeted ask) is attached to deterministic candidates (`analyze()`'s `...(scope.method==='prompt' ? {prompt:...} : {})`) but **never reaches `llmAssist()`** — `buildPrompt()` always asks the same fixed generic ACX/QIX/SX sweep over every feature, ignoring the user's actual question and the scope's feature restriction. Real gap, but it's a framer→LLM-hunter wiring/UX issue, not an executor→verifier or coverage-honesty issue. **Out of scope for this design** — flagged for a separate ticket. |
| **Hunter fan-out** (orchestrator, bounded concurrency, per feature×pattern) | **BUILT** (for what needs it) | The SSE preview path (`routes.js` `GET /stream`) genuinely fans `planJobs()` jobs through `packages/orchestrator`'s `runAll()`. The authoritative `runAssessment()` calls `analyze()` **once** over the whole graph instead of per-job — but `analyze()` is a pure, synchronous, in-memory function; running it N times concurrently would be pure ceremony with no result difference. `index.js`'s own comment on the stream route says this plainly. Verdict: adequate as-is. |
| ...LLM-assist fan-out (`llmAssist`'s per-batch loop) | **PARTIAL (not fixed here)** | Sequential `for` loop over batches, not routed through `packages/orchestrator`. Latency-only concern (bounded by `LLM_CAP`/`LLM_TIMEOUT_MS`), not a correctness or honesty gap. YAGNI — see §3. |
| **Triager** (decisive-rejection, drop keyword matches) | **BUILT, once §2a below lands** | Today `triaged = allCandidates.map(c => ({...c, triaged:true}))` is a label-only no-op — there is no separate rejection logic at this stage. That's fine for deterministic candidates: `rules.js`'s rules are graph predicates, not keyword/regex hits, so there is no "keyword match" noise to triage away pre-validate. The *only* keyword/prose-derived candidates in the whole pipeline are the LLM-assist ones (`parseLlmCandidates`'s lenient branch literally does keyword matching). Once §2a's independent re-proof gate exists, it **is** the decisive-rejection control for that noise — a separate formal "triager" stage would just be re-labelling the same check. Do not build a second stage. |
| **Validator: executor→verifier separation** (deterministic vs deterministic) | **BUILT** | `REVERIFY` re-derives each deterministic candidate's predicate fresh from the current graph (not from the candidate's cached fields) — this is what lets IDOR/missing-auth findings correctly disappear once an `AUTHORIZED_BY`/`AUTHENTICATED_BY` edge appears. The rule engine is explicitly documented as "the always-reliable base" — a deterministic-rule-vs-deterministic-reverify pairing is not the case BACKEND-ARCHITECTURE §1 is guarding against. |
| **Validator: executor→verifier separation** (LLM-origin candidates) | **MISSING** | See §0. `validateCandidate` passes every `rule:'llm'` candidate unconditionally. This is the one confirmed, severity-relevant gap. |
| **Reporter** (freeze validated record → Finding) | **BUILT** | `report()` (`index.js:202`) writes the finding, the graph shadow nodes/edges (`VULN_CANDIDATE`, `FINDING`, `VIOLATES`, `MAPS_TO_CWE`, `CANDIDATE_IN`, `PROMOTED_TO`), and an event, atomically per candidate, before `computeCoverage()` runs. No gap. |
| **CWE coverage checklist — denominator integrity (feature×family matrix)** | **BUILT** | `computeCoverage()`'s `percent` is `decided / (features × families)` where `decided` excludes only `'open'` cells — this is the validated-applicable-matrix bijection the plan calls for, not a raw 281-pattern or 24-CWE catalog count. Every feature×family cell gets a verdict (`vuln`/`na`/`pass`/`open`); nothing is silently skipped. |
| **CWE coverage checklist — per-CWE "assessed / N/A-with-reason / open" view** | **MISSING** | §5.2 asks for a checklist keyed **by CWE** ("per CWE, whether it was assessed, N/A-with-reason, or open"). What exists is `coverage.byCwe`, which only lists CWEs that already have a finding (`groupByCwe(findings)` — a tally, not a checklist), and `GET /api/cwe` (`cweCatalog()`), which is a static family→CWE union with **no verdict at all**. There is no single place that says, for CWE-89 (SQLi), "N/A — no detector" versus for CWE-639 (IDOR), "assessed — clean" or "assessed — 2 findings." Also: `FAMILIES.ACX.cwe` is `['CWE-284','CWE-639','CWE-862','CWE-863']`, but `ruleMissingAuth` actually emits `CWE-306` under family `ACX` — a CWE a real ACX finding carries but that the family's own registered CWE list doesn't contain. A naive per-CWE rollup built off `FAMILIES` data would silently mis-scope this. See §2b. |
| **Agent role contracts** (`packages/agents`) | **BUILT as data, correctly unused as process** | `packages/agents/src/index.js` defines `ROLES` (framer/hunter/triager/validator/reporter) as metadata (purpose, tools, `fansInto`) with an explicit comment: "Executor→verifier separation is enforced: a validator can never validate its own work." Nothing in `packages/assess` currently reads `ROLES` — the deterministic pipeline doesn't need per-role SDK subagents to enforce that promise; it enforces it (or, today, fails to — §0) directly in code. That's fine: the roles exist for when/if a *reasoning* agent (not just the bounded LLM-assist call) is spawned per stage; wiring real per-stage subagents for a deterministic pipeline would be pure ceremony. |

---

## 2. The genuinely-missing rigor to build

### 2a. Executor→verifier separation for LLM-assist candidates (the fix that matters)

**Principle:** an LLM-nominated candidate may only become a finding if the *deterministic engine*,
independently, on its own predicate logic, also flags the same endpoint. The LLM's role stays
exactly what the code comment already says it should be — "only ever ADDS candidates on top" of
the deterministic base, never a source of truth by itself.

**Design — reuse the rule producers themselves as the verifier** (no new predicate logic to write
or maintain in parallel with `rules.js`'s existing `RULES`):

```js
// rules.js — new export. Independent re-proof for an LLM-nominated candidate: does the
// deterministic engine, run fresh, ALSO flag this exact endpoint for this exact family?
// Returns null (drop) when it doesn't — an LLM lead the deterministic engine can't
// independently support is NEVER promoted, regardless of how plausible the model's text was.
// On success, returns the DETERMINISTIC rule's own candidate shape (rule id, cwe, severity,
// title, evidence — real file:line, not the LLM's null evidence) with the LLM candidate's `id`
// kept, so a promoted "LLM-assisted" finding is, in substance, byte-for-byte what the
// deterministic engine would have produced unassisted.
export function reproveLlmCandidate(candidate, graph) {
  const idx = indexGraph(graph);
  if (!idx.nodeById.get(candidate.endpointId)) return null;
  for (const r of RULES) {
    if (r.family !== candidate.family) continue;
    const hit = r.run(idx, graph).find((c) => c.endpointId === candidate.endpointId);
    if (hit) return { ...hit, id: candidate.id, llmNominated: true };
  }
  return null; // no deterministic rule exists for this family (e.g. QIX, SX today) → never verified
}
```

Why this is correct and not circular: the *executor* is the LLM (it nominated a route+family from
prose); the *verifier* is the deterministic rule engine, invoked completely fresh, with no
knowledge of what the LLM said beyond "check this endpoint/family." Reusing `RULES`' own `r.run()`
is the YAGNI-correct choice (rung 2 of the ladder: it's already in this codebase) — writing a
second, parallel predicate implementation "for independence" would drift from `rules.js` the first
time either one is edited, which is a worse honesty risk than reuse.

For families with no deterministic rule at all (`QIX`, `SX` today — see `LLM_FAMILIES` in
`index.js`), the `for` loop simply never matches, so `reproveLlmCandidate` returns `null` for
every candidate in that family, always. That's the correct behavior with **zero extra code**: a
family SecForge can't independently check can never produce a "verified" finding via the LLM
path either, matching the honest-coverage principle by construction rather than by a special case.

**`index.js` wiring** (replaces the single filter/map in `runAssessment`):

```js
let llmDropped = 0;
const validated = [];
for (const c of triaged) {
  if (c.rule === 'llm') {
    const reproved = reproveLlmCandidate(c, graph);
    if (reproved) validated.push(reproved); else llmDropped++;
  } else if (validateCandidate(c, graph)) {
    validated.push({ ...c, verified: true });
  }
}
onEvent?.({ stage: 'validator', queued: triaged.length, verified: validated.length, llmDropped });
```

**Also fix the unconditional-pass default** in `validateCandidate` itself, as a defensive backstop
against the same class of bug reappearing for a future rule id added to `RULES` without a matching
`REVERIFY` entry:

```js
return fn ? fn(candidate, idx) : false;   // was: true — "no reverify logic" must mean REJECT, not PASS
```

This is safe: every rule `RULES` actually produces has a `REVERIFY` entry today (checked — 4 rule
ids, 4 entries), so this only changes behavior for candidates that shouldn't have been passing.

**Small companion fix — scope leakage.** `llmAssist()`'s `summarizeFeatures()` always summarizes
every feature regardless of `scope.mode`/`scope.feature`, so a "Targeted: feature X only" run's
LLM-assist candidates aren't bounded to feature X the way the deterministic candidates already are
(`analyze()`'s own `inScope` filter). Export `inScope` from `rules.js` and apply it once, uniformly,
to `allCandidates` right after the LLM candidates are concatenated in `index.js` — one line, closes
the leak without touching `llmAssist()`'s prompt-building at all.

**`findingOf()` — one additive field for auditability** (not a shape change, an added optional
field the finding record schema already reserves room for — see §4):

```js
verified_by: candidate.llmNominated ? 'llm-nominated+rule-confirmed' : 'rule',
```

### 2b. CWE-coverage checklist (assessed / N/A-with-reason / open, keyed by CWE)

**Fix the data first (1 line, `packages/patterns/src/index.js`):** add `'CWE-306'` to `ACX`'s `cwe`
array so the family's registered CWE list stops omitting a CWE its own rule actually emits.

**Add a single source of truth for "which CWEs SecForge can actually detect"** (`rules.js`, mirrors
the existing `RULE_CVSS` object exactly — same file, same pattern, no new concept):

```js
export const RULE_CWE = Object.freeze({
  'ACX-idor-no-owner-check': 'CWE-639',
  'ACX-missing-authentication': 'CWE-306',
  'REX-no-rate-limit': 'CWE-770',
  'SDX-unauth-datastore-reachable': 'CWE-200',
});
```

This is the honest denominator at CWE granularity: `FAMILIES.ACX.cwe` lists 4 CWEs but only 1 of
them (`CWE-639`) has a detector — `CWE-284`/`CWE-862`/`CWE-863` are family-adjacent but
undetected. Rolling a checklist off `FAMILIES` (family-level "applicable") would overclaim; rolling
it off `RULE_CWE` (rule-level "actually implemented") does not.

**Add one pure function in `coverage.js`**, computed from data `computeCoverage()` already has
(`matrix`, `findings`) — no new graph walk:

```js
// Per-CWE checklist over the FULL canonical catalog (cweCatalog()), never a raw count.
// 'assessed' = a deterministic rule exists for this exact CWE (RULE_CWE) and ran; verdict is
//   'vulnerable' (>=1 finding carries this cwe) or 'clean' (ran, nothing found).
// 'open'      = a rule exists for this CWE but its family never had ANY surface anywhere in the
//   project (every feature's cell for that family is 'open' — nothing to check yet, e.g. an
//   empty project). Rare in practice.
// 'na'        = no automated detector implements this CWE at all — reason is always given, never
//   silently dropped from the list.
function cweChecklist(matrix, families /* FAMILIES */, findings) {
  const detectedByCwe = new Map();               // cwe -> owning family prefix
  for (const [rule, cwe] of Object.entries(RULE_CWE)) {
    detectedByCwe.set(cwe, RULES.find((r) => r.run.name.toLowerCase().includes(rule.split('-')[0].toLowerCase()))?.family
      /* simplest robust form: RULES entries already carry .family; match by re-deriving from RULE_CVSS's rule id prefix, or just hand-pair rule→family since RULES.length is 4 */);
  }
  return cweCatalog().map(({ id, name, families: owningFamilies }) => {
    const rule = Object.keys(RULE_CWE).find((r) => RULE_CWE[r] === id);
    if (!rule) return { cwe: id, name, status: 'na', reason: 'no automated detector implements this CWE yet' };
    const family = owningFamilies.find((f) => RULES.some((r) => r.family === f)); // the family that actually owns `rule`
    const cells = matrix.flatMap((row) => row.cells.filter((c) => c.family === family));
    const vulnCount = findings.filter((f) => f.cwe === id).length;
    if (vulnCount > 0) return { cwe: id, name, status: 'assessed', verdict: 'vulnerable', count: vulnCount };
    if (cells.some((c) => c.verdict === 'pass')) return { cwe: id, name, status: 'assessed', verdict: 'clean' };
    return { cwe: id, name, status: 'open' }; // detector exists, no feature offered any surface
  });
}
```

(The `RULE_CWE`→family lookup above is fiddlier than it needs to be written inline in this doc —
the concrete implementation should just pair `{rule, family, cwe}` triples directly off `RULES`
and `RULE_CWE` once, e.g. by adding `cwe` alongside `family` on each `RULES` entry, since every
rule function already only ever emits one `cwe`. That removes the lookup entirely.)

Wire it into `computeCoverage()`'s return as a **new, additive top-level field**:

```js
const result = { percent, features: ..., families, matrix, byCwe: groupByCwe(findings), cweChecklist: cweChecklist(matrix, FAMILIES, findings) };
```

`percent`, `matrix`, and `byCwe` are unchanged — this only adds a key. `GET
/api/projects/:id/coverage` and the UI (which today doesn't render `byCwe` or the `/api/cwe`
catalog at all — checked, no matches in `apps/server/public/*.html`) are unaffected until someone
wires a "By CWE" panel to the new field.

---

## 3. What to explicitly NOT build (YAGNI)

- **A formal, separate Triager stage/agent.** The deterministic rules produce no keyword noise to
  reject; once §2a's reprove-or-drop gate exists, it *is* the decisive-rejection control for the
  only noisy input source (LLM prose). A second stage would be the same check wearing a second
  name.
- **Real per-stage Agent SDK subagents for framer/hunter/triager/validator/reporter.**
  `packages/agents`'s `ROLES` already document the contract as data; spawning five actual reasoning
  subagents per scan for a pipeline that is (by design, per `index.js`'s own top comment)
  deterministic-first would add latency, cost, and a new failure surface for zero honesty gain.
  Build this only if/when a stage genuinely needs LLM reasoning it doesn't have today (e.g. a
  smarter question-framer for free-text asks) — and even then, wire it as another optional-assist
  call like `llmAssist()`, gated the same way, not a redesign of the pipeline shape.
- **Routing `llmAssist()`'s batch loop through `packages/orchestrator`.** It's a latency-only gap
  (sequential vs. concurrent LLM calls), bounded by `LLM_CAP`/`LLM_TIMEOUT_MS`, with a hard 180s+
  timeout already in place. Not a rigor issue.
- **Fixing prompt-mode fidelity into `llmAssist()`'s prompt text.** Real, but a framer→hunter UX
  wiring issue, orthogonal to executor→verifier and coverage honesty. Separate ticket.
- **The Python/StaticCodeReview orchestrator.** Superseded per BACKEND-ARCHITECTURE §3 — SecForge's
  own `packages/orchestrator` already covers the fan-out this pipeline needs.
- **Any new dependency.** Everything above is stdlib + existing `packages/*` reuse (`RULES`,
  `REVERIFY`, `cweCatalog()`, the adapter registry's `register()` for tests).
- **Per-feature×CWE granularity in the coverage matrix.** §5.2 asks for a flat per-CWE checklist,
  not a feature×CWE cube. The existing feature×family `matrix` already carries per-feature
  precision at the granularity that matters (family); §2b's checklist is a project-level rollup on
  top of it, not a new axis.

---

## 4. API/shape impact

- `runAssessment()`'s return shape is **unchanged**: `{jobs, candidates, findings, coverage,
  engineUsed}`.
- Finding record: **one additive field**, `verified_by: 'rule' | 'llm-nominated+rule-confirmed'`.
  Every existing consumer that doesn't know this field ignores it; nothing existing reads or
  requires it.
- `VERIFICATION` enum in `packages/schemas` already contains `'unverified'`/`'verified'`/`'rejected'`
  — **not used differently by this design**, since §2a's fix means a promoted finding is now
  *actually* verified 100% of the time (dropped candidates never become finding records at all,
  matching the pipeline's existing pattern for deterministic candidates that fail `validateCandidate`
  today). No new enum value needed.
- `coverage.json` / `GET /api/projects/:id/coverage`: **one additive top-level field**,
  `cweChecklist`. `percent`, `matrix`, `byCwe` unchanged, same shape, same values.
- `onEvent` progress callback (SSE `stream`/`scan`): the `'validator'` stage event gains
  `verified`/`llmDropped` counts alongside the existing `queued`. Additive.
- `FAMILIES.ACX.cwe` in `@secforge/patterns`: gains `'CWE-306'`. This only *adds* a CWE to the
  family's declared set; nothing currently asserts ACX has exactly 4 CWEs.

---

## 5. Test plan

All in `packages/assess/test/assess.test.js` (or a new `rules.test.js` if that file is getting
long — see the file's own <500-line convention) plus one adapter-registry-backed integration test.

1. **Executor→verifier — corroborated LLM candidate is promoted, and re-attributed.**
   Build a graph with an unauthenticated endpoint (no `AUTHENTICATED_BY`/`AUTHORIZED_BY` edges).
   Construct an LLM-shaped candidate object (`family:'ACX', rule:'llm', endpointId, cwe:'CWE-284'`
   — the *wrong*, generic guessed CWE). Assert `reproveLlmCandidate(candidate, graph)` returns a
   non-null object whose `rule` is `'ACX-missing-authentication'` and `cwe` is `'CWE-306'` — i.e.
   the promoted record wears the deterministic engine's own verdict, not the LLM's guess.

2. **Executor→verifier — uncorroborated LLM candidate is dropped, never "verified."**
   Same graph but the endpoint now carries a valid `AUTHORIZED_BY` edge (genuinely not vulnerable).
   Assert `reproveLlmCandidate(candidate, graph)` returns `null`. Then assert, via
   `runAssessment()` with a `register()`-ed mock adapter (`available: async()=>true, ask: async()=>
   'ACX|bogus IDOR|GET|/orders/:id|high'`) pointed at this graph, that `findings` contains **no**
   entry for that endpoint/family — the model's claim never becomes a finding despite being
   plausible-looking text.

3. **Executor→verifier — a family with no deterministic rule (QIX/SX) never verifies, ever.**
   Any graph, any endpoint. An LLM candidate with `family:'QIX'` (or `'SX'`) always returns `null`
   from `reproveLlmCandidate`, regardless of how the endpoint looks — proving "can't independently
   support ⇒ never promoted" holds even when the underlying claim might well be true.

4. **Regression — unknown non-`'llm'` rule id now rejects, not passes.**
   `validateCandidate({rule: 'not-a-real-rule', ...}, graph)` returns `false` (was `true`).

5. **Scope leak closed.** A `scope:{mode:'feature', feature:'f:orders'}` run with an LLM candidate
   whose `featureId` is a *different* feature is excluded from `allCandidates` before validation
   even reaches it (assert candidate never reaches `reproveLlmCandidate`/`validateCandidate` at
   all, or equivalently that it's absent from the final `findings`).

6. **Coverage denominator — per-CWE checklist is honest.** On the existing `computeCoverage()` test
   fixture (one feature, one `ACX` endpoint with authn, one data store): assert
   `cov.cweChecklist` contains an entry for `'CWE-89'` (SQLi) with `status:'na'` and a `reason`
   string (never silently absent from the list); an entry for `'CWE-639'` with `status:'assessed'`
   (`verdict:'clean'` before a finding is written, `verdict:'vulnerable', count:1` after — reuse
   the existing before/after finding-write pair already in that `describe` block); and that the
   total number of `cweChecklist` entries equals `cweCatalog().length` (every CWE in the catalog
   gets a verdict — bijection, nothing silently skipped).

7. **`FAMILIES.ACX.cwe` regression guard.** Assert every value in `RULE_CWE` whose rule id starts
   with `ACX-` is present in `familyByPrefix('ACX').cwe` — catches the class of drift that produced
   the CWE-306 gap if it recurs for a future rule.

---

## Summary

- **Gap table:** framer, hunter fan-out, reporter, and deterministic-candidate validation are
  **BUILT** and adequate — don't touch them. Triager is a no-op label today but doesn't need to be
  more than that once §2a lands. Two real gaps: **(1)** LLM-assist candidates bypass independent
  verification entirely (`validateCandidate` defaults unknown rules to `true`), letting an
  unverifiable LLM guess become a "verified" finding — including for CWE families (QIX SQLi, SX
  SSRF) SecForge has **no deterministic detector for at all**. **(2)** the CWE coverage checklist
  §5.2 describes (per-CWE assessed/N-A-with-reason/open) doesn't exist — only a raw finding tally
  (`byCwe`) and a verdict-free static catalog (`cweCatalog()`), and the family-level applicability
  set would overclaim if naively rolled up to CWE granularity (ACX claims 4 CWEs, only 2 have
  detectors, one of which — CWE-306 — isn't even in the family's own registered list).
- **Worth building (2 things):** (a) `reproveLlmCandidate()` in `rules.js` — re-run the existing
  deterministic `RULES` against an LLM-nominated endpoint and only promote on independent
  corroboration, re-attributing the finding to the deterministic rule's own cwe/severity/evidence;
  wire it into `runAssessment()` in place of the current unconditional pass. (b) a `cweChecklist()`
  rollup in `coverage.js`, keyed off a new explicit `RULE_CWE` map (mirrors the existing
  `RULE_CVSS` pattern) rather than the coarser, occasionally-inconsistent `FAMILIES.cwe` arrays.
- **Deliberately not building:** a separate formal Triager stage, real per-stage Agent SDK
  subagents for a deterministic pipeline, concurrent fan-out for the optional LLM-assist batch loop,
  prompt-mode fidelity into `llmAssist()`, the superseded Python orchestrator, any new dependency,
  and a feature×CWE coverage cube (the plan only asks for a flat per-CWE checklist). All either add
  ceremony with no honesty gain, or are real-but-separate issues outside this task's rigor scope.
