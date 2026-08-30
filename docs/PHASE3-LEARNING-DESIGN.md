# Phase 3 (Patterns + Memory) — Honest Gap Analysis & Learning Design

> Status: DESIGN ONLY — no code changed by this doc.
> Scope: `docs/SECFORGE-PLAN.md §5.4` (pattern mining) and `§5.6` (memory / self-learning),
> checked against what `packages/memory`, `packages/patterns`, `packages/assess`, and
> `apps/server` actually do today. Custom pattern import (§5.4's other half) and keyword
> recall (§5.6) already exist and are not redesigned here — this doc only covers the
> genuinely-missing "improves day by day" machinery: the accept/reject loop, pattern mining,
> consolidation, and honest UI wiring.
>
> **Explicitly NOT designed here** (per instructions): sqlite-vec / embedded vector recall
> (`SECFORGE-PLAN.md §9.4` decision #4, `§10` YAGNI list) — keyword recall stays the v1 answer.
> No new npm dependencies. No fabricated learning metrics (precision, confidence, "quality
> score") — every number the UI shows must be a real count of something on disk.

---

## 0. Headline finding

**Pattern mining does not exist at all**, and the **accept/reject loop has no producer** —
the file format and the reader (`recall`) are real, but nothing in the product ever writes an
accept/reject verdict, and nothing ever derives a learned pattern from a scan. The Memory tab's
"Learned patterns" list is also dead code: `refreshMemory()` in `apps/server/public/index.html`
reads `d.stats.learned || d.learned`, but `stats()` in `packages/memory/src/index.js` never
returns a `learned` field and `GET /api/projects/:id/memory` never returns top-level `learned`
either — so that list has never once rendered a real entry. Today "learning" is 100%
manual: a caller can `POST /api/projects/:id/memory` with an arbitrary `{name, kind, note,
family}` and it gets appended verbatim. Nothing in the codebase has ever called it from a scan.

---

## 1. Gap analysis table

| §5.4/§5.6 element | Verdict | Evidence |
|---|---|---|
| **learned-patterns store** (`learned-patterns.md` + `feedback.jsonl`, files are the source of truth) | **BUILT** | `packages/memory/src/index.js:11-41` — `record()` appends to `feedback.jsonl`; `learn()` appends a `- **name** [kind] (family) — note` line to `learned-patterns.md` and mirrors it into `feedback.jsonl`. Git-diffable plain files, exactly as §5.6 asks. |
| **Keyword recall** (in-project) | **BUILT** | `recall()` (`index.js:19-26`) does a case-insensitive substring filter over `learned-patterns.md` lines. Honestly labelled: `note: 'keyword recall — vector index (sqlite-vec) added later'`. |
| **Cross-project recall** | **BUILT** | `crossProjectRecall()` (`index.js:45-59`) walks every project's `learned-patterns.md` and returns `{project, hit}` pairs. Wired to `GET /api/projects/:id/memory?q=` (`routes.js:115-118`) and to the Memory tab's `runRecall()` (`index.html:1803-1817`). |
| **stats()** (patterns/signals/projects counts) | **BUILT, but the "signals" number is dishonest today** | `stats()` (`index.js:69-74`) counts every line in `feedback.jsonl` as a `feedbackSignals`, labelled in the UI as **"accept / reject signals"** (`index.html:704`). But `feedback.jsonl` today only ever receives `learn()`'s own mirror writes (`{type:'learned', ...}`) plus whatever a caller passes to `record()` directly — there is no accept/reject producer (next row), so in the one real code path that exists, "accept/reject signals" is actually counting *pattern-learn* events, not verdicts. This is exactly the class of misleading-metric the "no fabricated 84% triage precision" constraint guards against, just milder — it's a real count, wearing the wrong label. Fixed in §2 by adding real `accepted`/`rejected` fields instead of overloading one count. |
| **ACCEPT/REJECT feedback loop** | **MISSING** | No route, no UI control, no persisted verdict anywhere. `packages/memory/src/demo.js:21` calls `record(store, projectA.id, { type: 'feedback', verdict: 'confirmed' })` — but that is a **test-only illustration** of `record()`'s generic shape, never invoked from `apps/server` or the UI. Grep confirms zero product callers of `record()` outside that demo. |
| **PATTERN MINING** (post-scan, derive learned patterns from confirmed findings) | **MISSING** | `runAssessment()` (`packages/assess/src/index.js:256-301`) ends at `report()` + `computeCoverage()`; it never touches `@secforge/memory`, and `packages/assess/package.json` doesn't even depend on it. `learn()` is reachable only via the manual `POST /api/projects/:id/memory` route (`routes.js:148`), which takes whatever the caller sends — it is not derived from anything. |
| **Scheduled CONSOLIDATION** (dedup/prune) | **MISSING** | No dedup logic exists anywhere in `packages/memory`. `learn()` appends unconditionally — calling it twice with identical arguments produces two identical lines. No route, no scheduler, no on-demand trigger. |
| **"Learned this cycle" UI** | **MISSING (dead code today)** | `index.html:1793-1800`'s `refreshMemory()` reads `s.learned || d.learned` and renders it into `#memLearned` — but `GET /api/projects/:id/memory`'s handler (`routes.js:115-118`) only ever returns `{stats, recall, cross}`; there is no `learned` key at any level of that response. The empty state (`index.html:710`, "Nothing learned yet…") is therefore the *only* thing that has ever rendered, regardless of what's in `learned-patterns.md`. There is also no concept of "this scan's cycle" vs. "all time" anywhere. |

---

## 2. The genuinely-worth-building pieces (4)

Kept to exactly what §5.4/§5.6 ask for and nothing else:

1. **Accept/reject feedback endpoint + a reject-guard that resurfaces on re-scan** (§3).
2. **Deterministic pattern mining after a scan** (§4).
3. **On-demand consolidation route** (dedup pass, no scheduler) (§5).
4. **Honest UI wiring**: Findings tab accept/reject controls, Memory tab "Learned this cycle" +
   fixed `learned` catalog + real accepted/rejected counts (§6).

**Deliberately not building:** sqlite-vec / any vector or embedding recall (explicitly deferred,
§9.4); near-duplicate/fuzzy pattern collapsing (that's vector-similarity territory — exact-string
dedup only, see §5); age-based pruning of accept/reject verdicts (would silently un-suppress a
user's own past decision — dishonest, see §5); a background scheduler/cron for consolidation
(on-demand route is simpler and just as correct — YAGNI); router "weights" learned from
outcomes (§5.6 mentions it in passing for the multi-provider router, which is Phase 4's
concern, not this doc's); any precision/accuracy/confidence percentage anywhere (never
computable honestly from counts this small — the exact failure mode the `84% triage precision`
ui-smoke guard in `apps/server/test/ui-smoke.test.js:19` exists to prevent).

---

## 3. The accept/reject learning loop

### 3.1 Why suppression, not deletion

A rejected finding means "this specific rule-shape is a false positive **for this project**"
(e.g. the graph mapper didn't recognize a custom auth decorator). The deterministic rule that
produced it is still, mechanically, true against the current graph — silently hiding it on the
next scan would misrepresent what the rule engine actually found and would be indistinguishable
from a real regression (the guard-gap could still be real, or could have been reintroduced).
So: **never suppress silently.** A rejected shape is re-surfaced, honestly labelled "you
previously marked this a false positive," and deprioritised in the default view — not deleted,
not hidden, and coverage/severity counts stay untouched (the deterministic finding is still a
real finding; only Findings-tab *presentation order* changes).

### 3.2 The guard key

`rule::route` (e.g. `ACX-idor-no-owner-check::GET /orders/:id`) — both fields already exist on
every finding (`finding.rule`, `finding.route` — see `packages/assess/src/index.js:34-56`
`findingOf()`). This is more specific than `family::route` (used elsewhere for LLM dedup) and
stable across re-scans of the same project, since the rule id and the route string don't change
unless the code itself changes.

### 3.3 Feedback entry shape (`feedback.jsonl`)

```json
{
  "at": "2026-08-30T12:00:00.000Z",
  "type": "finding.verdict",
  "findingId": "finding:F-3-acx-idor-no-owner-check",
  "rule": "ACX-idor-no-owner-check",
  "cwe": "CWE-639",
  "feature": "feature:orders",
  "route": "GET /orders/:id",
  "verdict": "reject",
  "note": null
}
```

`type: 'finding.verdict'` distinguishes it from `learn()`'s existing `type: 'learned'` mirror
entries in the same file — both stay in one append-only JSONL, matching the existing convention.

### 3.4 New route: `POST /api/projects/:id/feedback`

Body: `{ findingId, verdict: 'accept'|'reject', note? }`. Handler (in `routes.js`, next to the
existing `findings/:id/validate` route which already does the identical "find by id in
`listFindings()`" lookup):

1. `store.listFindings(pid)`, find by id (404 if not found — same pattern as the validate route).
2. Reject a `verdict` that isn't `'accept'`/`'reject'` with 400 (no silent coercion, matching
   the `scopeInputError` convention already in this file).
3. Append the entry above via a new `packages/memory` export, `recordVerdict(store, projectId, {findingId, rule, cwe, feature, route, verdict, note})`.
4. Merge `{ feedback: { verdict, at } }` onto the finding's own JSON (read → merge → `store.writeFinding()` — `writeFinding` already overwrites by id, so this needs no new `Store` method) so the *specific* finding the user acted on carries its own verdict permanently, independent of the guard mechanism below.
5. Respond `{ ok: true, findingId, verdict }`.

### 3.5 Re-surfacing on the next scan: `annotatePriorFeedback()`

New `packages/memory` export, called from `routes.js`'s `POST .../scan` handler **after**
`runAssessment()` returns (not inside `packages/assess` — assess stays a pure detector with no
new dependency on memory; `routes.js` is already the layer that glues store+session+assess
together for this exact handler):

```js
export async function annotatePriorFeedback(store, projectId, findings) {
  const file = path.join(memDir(store, projectId), 'feedback.jsonl');
  let entries = [];
  try {
    entries = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { /* no feedback yet */ }
  const latestByKey = new Map(); // "rule::route" -> latest finding.verdict entry
  for (const e of entries) {
    if (e.type !== 'finding.verdict') continue;
    const key = `${e.rule}::${e.route || ''}`;
    const prev = latestByKey.get(key);
    if (!prev || e.at >= prev.at) latestByKey.set(key, e); // ISO strings sort lexically = chronologically
  }
  let flagged = 0;
  for (const f of findings) {
    const prior = latestByKey.get(`${f.rule}::${f.route || ''}`);
    if (prior) { f.priorFeedback = { verdict: prior.verdict, at: prior.at, findingId: prior.findingId }; flagged++; }
  }
  return flagged;
}
```

`routes.js`'s scan handler then re-persists only the flagged findings (`store.writeFinding` per
flagged finding — cheap, only touches findings that actually match a prior verdict) so that a
later, independent `GET /api/projects/:id/findings` call (not just the scan's own response)
still shows the same honest badge. `priorFeedback` is an **additive** field — nothing existing
reads or breaks on its presence.

`f.priorFeedback.verdict === 'reject'` → Findings tab sorts it to the bottom of the default
list and shows "You marked this a false positive on `<date>`." `'accept'` → shown as "You
previously confirmed this," no reordering. Neither changes `computeCoverage()` — the
deterministic rule still fired, so the coverage matrix's `vuln`/`pass` verdict is unaffected
(§5.2's coverage bijection stays exactly what it is today; this doc doesn't touch it).

---

## 4. Pattern mining

### 4.1 What "mining" means here (and what it doesn't)

Deterministic and cited, per the constraint: group this scan's **validated findings** by
`rule` (the recurring rule+guard-gap shape, exactly as SECFORGE-PLAN.md's example names it),
and for each rule not already present in this project's `learned-patterns.md`, append one
real, cited entry via the *existing* `learn()` function — no new file format. There is no NLP,
no LLM, no invented text: the entry's title is the finding's own `title`, and its citation is
the finding's own `evidence.file:line` and `route`. This is not "extract genuinely-new reusable
patterns" in a generative sense — it's "record that this project has now demonstrated this
rule's shape at least once," which is the honest, buildable version of that sentence.

### 4.2 Dedup rule (monotonic growth, no duplicates)

Every mined line embeds a fixed marker `rule=<rule-id>` (via the `note` field `learn()` already
writes). Before mining rule `R`, read the current `learned-patterns.md` text and check for the
literal substring `rule=R`. If present, skip — this rule's shape is already in the catalog for
this project. If absent, mine it once. Rule ids (`ACX-idor-no-owner-check`, etc., from
`packages/assess/src/rules.js`'s `RULE_CVSS`/`RULE_CWE` keys) are unique and non-overlapping as
substrings of each other, so this is a safe, O(1)-per-rule exact check — no markdown parsing
needed.

**Not built:** near-duplicate collapsing across *different* rule ids that happen to describe a
similar idea (e.g. two hand-authored custom patterns that overlap). That needs semantic
similarity — the exact thing sqlite-vec is deferred for. Exact-marker dedup only.

**Not built:** updating an existing mined entry with a running count ("seen 4× this scan") or a
second citation once the rule fires again in a later scan. The append-only file convention this
codebase already uses everywhere (`learn()`, `record()`) never rewrites a line in place; the
first citation is enough to prove the shape is real, and the live finding count for that rule
is always available from `GET /api/projects/:id/findings` on the current scan — nothing is
lost by not tracking frequency in the markdown file too.

### 4.3 Entry shape (reuses `learn()` verbatim, no format change)

```
- **API key readable by any authenticated user reads an object by id without an ownership/authorization check** [pattern] (ACX) — mined from finding:F-3-acx-idor-no-owner-check; orders.controller.js:42; rule=ACX-idor-no-owner-check
```

`name` = the finding's own `title` (already a factual, evidence-grounded string —
`packages/assess/src/decorate.js`'s `describeFinding()`/the raw rule title, never LLM prose).
`note` = `mined from <findingId>; <file>:<line>; rule=<rule-id>` — the citation the task asks
for, verbatim from the finding's own `evidence`. `family` = the finding's `family`. `kind` =
`'pattern'` (already a valid `LEARN_KINDS` value — no schema change).

### 4.4 New export: `minePatterns(store, projectId, findings)`

```js
export async function minePatterns(store, projectId, findings) {
  const file = path.join(memDir(store, projectId), 'learned-patterns.md');
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch { /* none yet */ }
  const firstByRule = new Map();
  for (const f of findings) {
    if (f.rule && !firstByRule.has(f.rule)) firstByRule.set(f.rule, f);
  }
  const added = [];
  for (const [rule, f] of firstByRule) {
    const marker = `rule=${rule}`;
    if (text.includes(marker)) continue; // already mined for this project
    const loc = f.evidence?.file ? `${f.evidence.file}${f.evidence.line ? ':' + f.evidence.line : ''}` : 'no evidence';
    const note = `mined from ${f.id}; ${loc}; ${marker}`;
    const entry = await learn(store, projectId, { name: f.title, kind: 'pattern', note, family: f.family });
    text += marker; // keep the in-memory guard in sync within this single call
    added.push(entry);
  }
  return added;
}
```

Called from `routes.js`'s scan handler right after `annotatePriorFeedback`:

```js
const result = await runAssessment({ store, projectId: project, scope, engine, model });
const priorFeedbackFlagged = await annotatePriorFeedback(store, project, result.findings);
const mined = await minePatterns(store, project, result.findings);
return json(res, 200, { ...result, modelUsed: model, requested, reason, mined, priorFeedbackFlagged }), true;
```

`mined` and `priorFeedbackFlagged` are **additive** fields on the existing `POST /scan`
response shape — every existing field (`jobs`, `candidates`, `findings`, `coverage`,
`engineUsed`) stays exactly as-is.

`packages/assess` is untouched: no new dependency, no import, nothing added to its
`package.json`. `packages/memory`'s `package.json` needs `@secforge/store` added to its
declared `dependencies` (it already imports `Store` from there at runtime — an existing
oversight this design surfaces but doesn't need to fix to proceed, since npm workspaces hoist
regardless; flagged for the coder as a one-line drive-by).

---

## 5. Consolidation

### 5.1 What it does (exact-match only, no scheduler)

An on-demand pass, `consolidate(store, projectId)` in `packages/memory`, doing exactly two
things:

1. **`learned-patterns.md`**: collapse byte-identical duplicate lines (protects against the
   *manual* `POST /api/projects/:id/memory` route, which has no dedup at all — a user or script
   calling `learn()` twice with the same arguments today produces two identical lines forever).
   Mining itself (§4) can't create duplicates by construction, so this only ever fires on
   manually-authored entries.
2. **`feedback.jsonl`**: for `type: 'finding.verdict'` entries only, collapse to the single
   latest entry per `rule::route` key (the same key `annotatePriorFeedback` uses) — older,
   superseded verdicts for the same shape are redundant once a newer verdict exists. `type:
   'learned'` mirror entries are left untouched (they're a 1:1 audit trail of
   `learned-patterns.md` and pruning them independently would desync the two files for no
   benefit).

```js
export async function consolidate(store, projectId) {
  const dir = memDir(store, projectId);
  const lpFile = path.join(dir, 'learned-patterns.md');
  const fbFile = path.join(dir, 'feedback.jsonl');

  let lpBefore = 0, lpAfter = 0;
  try {
    const lines = (await fs.readFile(lpFile, 'utf8')).split('\n').filter(Boolean);
    lpBefore = lines.length;
    const deduped = [...new Set(lines)]; // exact-match only
    lpAfter = deduped.length;
    if (lpAfter !== lpBefore) await fs.writeFile(lpFile, deduped.join('\n') + '\n');
  } catch { /* nothing to consolidate */ }

  let fbBefore = 0, fbAfter = 0;
  try {
    const entries = (await fs.readFile(fbFile, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    fbBefore = entries.length;
    const latestByKey = new Map();
    const kept = [];
    for (const e of entries) {
      if (e.type !== 'finding.verdict') { kept.push(e); continue; }
      const key = `${e.rule}::${e.route || ''}`;
      latestByKey.set(key, e); // last write wins — entries are already in file order (chronological)
    }
    for (const e of latestByKey.values()) kept.push(e);
    fbAfter = kept.length;
    if (fbAfter !== fbBefore) {
      await fs.writeFile(fbFile, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  } catch { /* nothing to consolidate */ }

  return { learnedPatterns: { before: lpBefore, after: lpAfter }, feedback: { before: fbBefore, after: fbAfter } };
}
```

### 5.2 Trigger: on-demand route, not a scheduler

`POST /api/projects/:id/memory/consolidate` → `json(res, 200, await consolidate(store, pid))`.
No cron, no background timer (`§8` of `SECFORGE-PLAN.md` explicitly leaves "scheduled
consolidation" to Phase 5 polish; building a scheduler now would be pure ceremony for a
single-user, loopback tool — the Memory tab gets a "Consolidate now" button instead). Running
it twice in a row is a no-op the second time (idempotent) since there's nothing left to
collapse.

### 5.3 Explicitly not pruning by age

The task mentions "prune entries older than N." Deliberately **not building** this for
`finding.verdict` entries: an old reject is still the user's most recent word on that shape
until superseded by a newer verdict — auto-expiring it after N days would silently
un-suppress a decision the user made on purpose, which is worse than doing nothing. Superseding
(§5.1's dedup) already keeps the file from growing forever for any *actively re-scanned*
project; a project that's never scanned again just keeps its (small, capped-by-distinct-key)
feedback history forever, which is correct, not a leak.

---

## 6. UI wiring

### 6.1 Findings tab — accept/reject controls

Add two buttons next to the existing `Validate live` button in the header row
(`index.html:620`, `#findValidateBtn`'s sibling position): `Mark false positive` /
`Confirm`. `onclick` posts to `POST /api/projects/:id/feedback` with `{findingId:
state.selectedFinding.id, verdict}`, then re-renders the current finding's detail (to show its
own `feedback` field) and calls `refreshMemory()` so the Memory tab's counts update without a
page reload.

If the currently-rendered finding carries `priorFeedback` (§3.5), `renderFindingDetail()` shows
a small banner above `findWhatHappens`: *"You marked this a false positive on `<date>`"* /
*"You previously confirmed this."* `renderFindingsList()` sorts `priorFeedback.verdict ===
'reject'` findings to the bottom of the current filter's list (a `.sort()` on the existing
`list` array before rendering) — never removes them, never changes the severity filter counts.

### 6.2 Memory tab

- **Fix the dead `learned` catalog list**: extend `GET /api/projects/:id/memory`'s handler
  (`routes.js:115-118`) to also return top-level `learned` — parsed from `learned-patterns.md`
  via a new `listLearned(store, projectId)` export (regex over the existing `- **name**
  [kind] (family) — note` line format `learn()` already writes; empty array if the file doesn't
  exist — same "degrade to empty, never throw" convention as `loadCanonicalCards()`). This
  makes the existing (already-written, currently-dead) `index.html:1793-1800` rendering code
  work for the first time, with zero HTML changes needed there.
- **"Learned this cycle"**: a new section above the all-time catalog. Populated purely from the
  `mined` array returned by the *most recent* `POST .../scan` response in this browser session
  (`state.lastMined`), not from any new persisted state — deliberately simple: no new server-side
  "which scan was the last one" bookkeeping is needed. Honest empty state when no scan has run
  yet this session: *"Run a scan to see newly learned patterns from this cycle."* This means
  "this cycle" only reflects the current tab session, not history across a page reload — the
  all-time catalog (previous bullet) is always there for that. Documented ceiling, not hidden.
- **Real accepted/rejected counts**: extend `stats()` to also return `accepted`/`rejected`
  (count of `feedback.jsonl` entries with `type === 'finding.verdict'` and that verdict — a
  real, small, honestly-labelled count, never a percentage or "precision"). The existing
  `#memSignals` stat card switches from the current mislabeled all-types line count to
  `accepted + rejected`, which is what its label ("accept / reject signals") has claimed to
  show since it was written.
- **"Consolidate now" button**: calls the new consolidate route, shows the returned
  before/after counts inline (e.g. "learned-patterns: 12 → 10, feedback: 34 → 29"). No score,
  no "health" label — just the two real numbers.

None of this introduces a new percentage, confidence, or precision figure anywhere — every
number added is a direct `.length` of a real array. The existing `apps/server/test/ui-smoke.test.js`
fabrication guard (`'84% triage'` etc., line 19) continues to cover this class of regression
and needs no new markers for this feature, precisely because nothing here fabricates a metric.

---

## 7. API / shape impact (additive only)

| Change | Shape impact |
|---|---|
| `POST /api/projects/:id/feedback` (new) | New route. Request `{findingId, verdict, note?}`. Response `{ok, findingId, verdict}`. |
| `POST /api/projects/:id/memory/consolidate` (new) | New route. No body. Response `{learnedPatterns:{before,after}, feedback:{before,after}}`. |
| `POST /api/sessions/:id/scan` response | **Additive fields**: `mined: [...]`, `priorFeedbackFlagged: number`. Every existing field unchanged. |
| `GET /api/projects/:id/memory` response | **Additive field**: top-level `learned: [...]`. `stats` gains `accepted`/`rejected`; existing `patterns`/`feedbackSignals`/`projects` unchanged. `recall`/`cross` unchanged. |
| `finding.json` (persisted shape) | **Additive fields**: `feedback: {verdict, at}` (set only when the user acts on that exact finding) and `priorFeedback: {verdict, at, findingId}` (set only when a prior verdict matches this finding's `rule::route` on re-scan). Both optional/absent by default — nothing that reads `finding.json` today breaks. |
| `learned-patterns.md` line format | **Unchanged** — mining reuses `learn()`'s existing writer verbatim; only the *content* of `note` gains the `mined from ...; rule=...` convention for entries produced by mining (manually-`learn()`'d entries are untouched). |
| `feedback.jsonl` entry shape | **Additive `type` value**: `'finding.verdict'` alongside the existing `'learned'` and whatever ad-hoc shapes `record()` already accepted. No field is removed from the existing shape. |

No package gets a new npm dependency. `packages/memory`'s only new internal edge is calling its
own new exports from `apps/server/src/routes.js` (already its sole consumer today).

---

## 8. Test plan

Following the existing conventions: `node:assert`-based `demo.js` self-checks for
`packages/memory` (it has no `test/` dir today — matches its current style), `node:test` +
`node:assert/strict` for `apps/server/test/routes.test.js`.

1. **Reject → re-surface on re-scan** (`packages/memory/src/demo.js`, extended): `recordVerdict`
   a reject for `{rule:'ACX-idor-no-owner-check', route:'GET /orders/:id', ...}`, then call
   `annotatePriorFeedback` with a freshly-built findings array containing a new finding with the
   same `rule`/`route` — assert `f.priorFeedback.verdict === 'reject'` and the returned flagged
   count is `1`. A finding with a *different* route must not get flagged (assert `undefined`).
2. **Mining appends a real, cited entry once** (`demo.js`): call `minePatterns` with one
   finding for `rule: 'ACX-idor-no-owner-check'` carrying `evidence:{file:'a.js',line:10}` —
   assert `learned-patterns.md` gains exactly one line containing `a.js:10` and
   `rule=ACX-idor-no-owner-check`. Call `minePatterns` again with a *new* finding for the same
   rule (different file/line) — assert **no** second line is added (dedup by rule marker) and
   the returned `added` array is empty the second time.
3. **Consolidation collapses duplicates and keeps the latest verdict**
   (`demo.js`): manually append two byte-identical lines to `learned-patterns.md` and three
   `finding.verdict` entries sharing one `rule::route` key with increasing `at` timestamps
   (reject, then accept, then reject) — call `consolidate()`, assert `learnedPatterns.after ===
   learnedPatterns.before - 1` and `feedback.after` keeps exactly one entry for that key, and
   its `verdict` is the last one written (`'reject'`).
4. **Honest counts, no fabricated metric** (`apps/server/test/routes.test.js` +
   `ui-smoke.test.js`): a route-level test posts one accept and one reject through
   `handleApi()`, then `GET`s `/api/projects/:id/memory` and asserts `stats.accepted === 1` and
   `stats.rejected === 1` — real counts, not derived percentages. Extend the existing
   `ui-smoke.test.js` fabrication-string list (already covers `'84% triage'`) with nothing new
   required, but add an explicit assertion that the Memory-tab HTML contains no `%` character
   adjacent to the words "precision"/"confidence"/"accuracy" — a cheap regression guard for this
   specific feature.
