# SecForge — Architecture & Build Plan

> Status: DRAFT v0.2 · Owner: you · Engine: Claude Code · Date: 2026-08-29
>
> SecForge ships **self-contained** over the Claude Agent SDK + Node stdlib + SQLite; it
> implements sessions, fan-out, lifecycle and memory itself. See `docs/BACKEND-ARCHITECTURE.md`
> for the backend/runtime detail.
>
> **Implementation note:** the shipped `secforge/` code implements the map, assess and pattern
> engines as SecForge's own logic. Any reference projects were design inspiration read once at
> build time only — they are NOT runtime dependencies and are not required to run SecForge.
> The parts of this plan that describe "reusing" prior work are superseded by that self-contained build.

SecForge is a standalone security-scanning tool. You feed it a source tree; it maps
the codebase feature-by-feature into a durable knowledge base, then runs targeted or
full security assessments over that map — feature by feature, vuln-class by vuln-class —
with a triage/validate pipeline that only promotes real findings, a CWE-based coverage
checklist, custom-pattern support, multi-provider model selection, a test environment
for live validation, and a memory that improves day by day.

---

## 0. The one idea that makes it work: **the store is the truth, the context window is a cache**

The core requirement — *"never forget even when the context window is hit"* — is not solved
by a bigger model or a longer prompt. It is solved by making **on-disk project state the
single source of truth**, and treating every agent's context window as a disposable cache
rehydrated from that state.

- The moment a feature is mapped, a candidate is found, a coverage cell is closed, or a
  finding is promoted, it is **written to disk** (a file + a graph row) — not held in a chat.
- Any agent, in any session, at any later date, reloads exactly what it needs via a
  **bounded, source-cited context bundle** built from the store. A context reset loses nothing.
- This is precisely how your codengram already works (frozen snapshot → SQLite graph →
  atomic publish → Markdown projection, *no* reliance on model memory). SecForge extends
  that model to security state.

**Everything below serves this one idea.**

---

## 1. The lazy truth: you already built ~80% of this

| SecForge capability | Already exists in | What it gives us | Work needed |
|---|---|---|---|
| Feature-by-feature code **mapping** | `codengram-master` | Frozen content-addressed snapshot → deterministic fact extraction → Claude "Lead" agent derives business features (evidence-cited) → strict evidence validation → typed **SQLite knowledge graph** → atomic publish → `phase1-maps/` projection | Remove the "recon-only" guards; extend the graph with security nodes |
| **Assessment / triage / validate** pipeline | `StaticCodeReview/security-assessment-orchestrator` | Orchestrator-over-untrusted-workers, **executor→verifier** two-stage validation, denominator integrity (matrix↔registry↔test bijection), **8 coverage gates**, deterministic state CLI | Wrap the Python engine; wire to the new store & UI |
| **Vulnerability patterns** (canonical + custom) | `StaticCodeReview/vulnerabilities-pattern-skill` | **281 canonical pattern cards / 24 families**, a strict card schema + registry + validators, differential engine (5 ledgers), pattern-mining prompt | Add CWE mapping; expose custom-pattern import |
| **Report / finding** rendering | `StaticCodeReview/report-writing-skill` | Frozen-record → HackerOne / Cobalt / generic report, format linters | Feed the Findings tab |
| **Memory / self-learning** | *SecForge (new)* | Files + SQLite store as source of truth; optional embedded vector recall (`sqlite-vec`); accept/reject learning weights | Build over the store |
| **Multi-agent fan-out** | *SecForge (new)* | Own scheduler over Claude Agent SDK subagents; bounded concurrency; optional scratch worktrees | Build the orchestrator for per-feature × per-pattern fan-out |
| **Sandboxed untrusted-code exec** | *SecForge (new)* | Self-contained sandbox (container or WASM), no host FS, for running PoCs | Build for the test-environment validation step |

**SecForge is therefore an integration + shell project, not a greenfield build.** The new
code is: the unified project store, the session shell, the engine adapters (multi-provider),
the UI, and the glue that turns two separate pipelines into one.

---

## 2. Product shape

Standalone app = **CLI + local (loopback) web UI**, exactly the codengram model
(`node:http` server serving a single-file UI, forked workers for long scans). UI flows
authored in **Claude Design**.

```
secforge open ./my-repo        # resolve/create project, bind a session, launch UI
secforge scan ./my-repo        # headless full scan
secforge ls | doctor | ask     # inherited codengram-style commands
```

**Tabs** (each is a feature section in §5):

```
┌ SecForge ─ project: my-repo @ commit a1b2c3 ──────────────────────────┐
│  Map   │   Assess   │   Findings   │   Patterns   │   Env   │  Memory  │
└───────────────────────────────────────────────────────────────────────┘
```

### Session model (per-project isolation)

- `secforge open ./X` → resolves `projects/<id>/` (id = stable hash of source root),
  **binds one Claude Code session** to that project directory, and resumes prior state
  from the store. Open `./Y` → a *separate* project dir and a *separate* session.
- A session is a **thin binder** over the durable store. It holds no unique truth; killing
  and reopening it rehydrates identically. This is what lets work "continue in that session"
  indefinitely without context-window loss.
- codengram already scopes all data under `data/projects/<id>/`; SecForge adds the
  session pin + the "current project" pointer the UI reads.

---

## 3. System architecture (layers)

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI  (Claude Design → single-file HTML, served on loopback)           │
│  Map · Assess · Findings · Patterns · Env · Memory tabs               │
└───────────────▲───────────────────────────────────────────────────────┘
                │ JSON API + SSE progress  (node:http, Host/Origin guard)
┌───────────────┴───────────────────────────────────────────────────────┐
│  CLI + Orchestration Server                                            │
│  session binder · scan lifecycle · forked workers · job dispatch       │
└───────┬───────────────────────────────┬───────────────────────────────┘
        │                               │
┌───────▼─────────┐            ┌────────▼──────────────────────────────┐
│  MAP ENGINE     │            │  ASSESS ENGINE                        │
│  (from codengram)│           │  (from StaticCodeReview)              │
│  snapshot→graph  │  feeds →   │  hunt→triage→validate→report          │
│  phase1-maps     │  the map   │  coverage gates · executor/verifier   │
└───────┬─────────┘            └────────┬──────────────────────────────┘
        │                               │
        └───────────────┬───────────────┘
                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  THE PROJECT STORE  (source of truth — §4)                            │
│  frozen snapshot · index.sqlite (graph) · findings/ · coverage/       │
│  patterns/ · events.log · phase1-maps/                                │
└───────────────▲──────────────────────────────────────────────────────┘
                │ over the store
┌───────────────┴───────────────────────────────────────────────────────┐
│  SUPPORTING SERVICES · SecForge's own code, built over the store      │
│  memory/recall (sqlite-vec) · orchestrator (fan-out) · model router   │
│  (routing + learning weights) · sandbox (PoC validation)              │
└───────────────────────────────────────────────────────────────────────┘
                │
┌───────────────┴───────────────────────────────────────────────────────┐
│  ENGINE ADAPTERS  (multi-provider — §6)                               │
│  claude-code (default) · codex · kimi/OpenAI-compat · gemini · ollama │
└───────────────────────────────────────────────────────────────────────┘
```

---

## 4. The project store — data model (the durable core)

Reuse codengram's graph model verbatim, **extend it with a security layer.** Source of
truth is files + one SQLite index; an optional embedded vector index (`sqlite-vec`) accelerates semantic recall.

```
projects/<id>/
  project.json                       # {id, name, source_root, engine, created_at}
  session.json                       # bound session id, current revision
  snapshots/<snapshot-id>/           # content-addressed frozen source (codengram)
    source/  source-manifest.jsonl  snapshot.json
    publications/<pub-id>/
      index.sqlite                   # THE knowledge graph (below)
      phase1-maps/                   # rendered map projection (features, ledgers, roles)
    CURRENT                          # atomic pointer → live publication
  assess/
    coverage/COVERAGE.md  cwe-checklist.md   # CWE-mapped coverage view
    candidates/<C-id>.md               # pre-triage
    findings/F-<n>-<slug>/             # promoted, per-finding folder (report + evidence + poc)
    matrices/<family>/                 # feature × pattern matrix, bijection-tracked
    runs/<run-id>.json                 # each assessment run (provider, effort, scope, result)
  patterns/
    canonical/                         # 281 cards (from StaticCodeReview)
    custom/<set-name>/                 # YOUR imported pattern folders
  memory/
    learned-patterns.md                # accumulates day by day
    feedback.jsonl                     # accept/reject decisions
  events.log                           # append-only event stream (who did what, when)
```

### The knowledge graph (`index.sqlite`)

codengram's schema — `nodes / edges / claims / reconciliation` — with **provenance on every
claim** (`file, line_start, line_end, confidence, method`) and deterministic ids so re-scans
are idempotent. Keep the closed vocabulary discipline. **Add security node/edge types:**

```
NEW NODE TYPES:  VULN_CANDIDATE, FINDING, PATTERN, COVERAGE_CELL,
                 ASSESSMENT_RUN, TEST_ENV, EVIDENCE, CWE
NEW EDGE TYPES:  CANDIDATE_IN (candidate→feature),
                 VIOLATES (candidate→pattern),
                 GUARDED_BY (candidate→AUTH_CHECK),   # ties finding to the exact guard
                 MAPS_TO_CWE (pattern→CWE),
                 PROMOTED_TO (candidate→finding),
                 VALIDATED_BY (finding→EVIDENCE / TEST_ENV),
                 COVERS (coverage_cell→feature×pattern)
```

**Why this is the "wired properly / never forgets" answer:** when you later ask *"identify
access-control issues for feature X"*, the graph already holds feature X's endpoints, its
`AUTH_CHECK` guards, its `ACTOR`/`ROLE`/`PERMISSION` model, and every `file:line` behind
them. A candidate attaches by edge to those exact nodes. The finding's story —
*how the feature actually works from source → where the guard fails* — is a graph traversal,
reproducible from disk with zero chat history. The finding tracker **is** the graph.

---

## 5. Feature breakdown (tab by tab)

### 5.1 Map tab — codebase → feature map
- **Ingest & freeze**: content-addressed snapshot; git sha/dirty recorded (codengram).
- **Deterministic inventory**: 11 raw `file:line` lists per language (routes, jobs, services,
  auth checks, datastores…), no model needed.
- **Semantic feature derivation**: Lead agent consolidates inventory into business features
  with evidence-cited selectors; every entity must cite `{file,line,symbol,reason}`;
  hallucinated citations dropped by the evidence validator.
- **Output**: per-feature map (13-section, cited), endpoint/action ledger, role model,
  cross-feature "same-functionality" clusters, and a **completion gate** separating technical
  coverage (facts extracted) from semantic coverage (mapped to features).
- **Coverage/QA agent**: audits the reconciliation ledger — proves every inventory row and
  every LOC reached a terminal status (mapped / shared-infra / not-relevant-with-reason /
  gap / dead-with-evidence). *This is your "every feature and line got covered" guarantee.*
- **Reuse**: codengram, near-wholesale. **New**: remove recon-only guards; persist into the
  extended store.

### 5.2 Assess tab — targeted or full security assessment
Two entry modes over the *same* map:
- **Targeted**: "Identify **access-control** issues for feature **X**." → a **Question-framer
  agent** turns it into a bounded job envelope (forbidden actor×resource×action×state tuple,
  scoped to feature X's nodes).
- **Full scan**: sweep **every feature × every applicable pattern family**; the matrix records
  a verdict for every cell so nothing is silently skipped.
- **CWE coverage checklist**: each pattern family maps to CWE IDs; the checklist shows, per
  CWE, whether it was assessed, N/A-with-reason, or open — the coverage denominator is the
  *validated applicable matrix*, never a raw catalog count.
- **The agent pipeline** (the team you described):
  1. **Question-framer** — scope & frame the ask precisely.
  2. **Hunter(s)** — fan out per feature×pattern (SecForge's orchestrator over Agent SDK
     subagents); produce candidates with the differential-engine evidence (5 ledgers).
  3. **Triager** — real vs bogus. Applies decisive-rejection controls; drops keyword matches.
  4. **Validator** — final gate: genuine finding vs informational. Independently reconstructs
     the path; **cannot validate its own work** (executor→verifier separation, enforced).
  5. **Reporter** — promotes the frozen record into a Finding under the Findings tab.
- **Reuse**: StaticCodeReview orchestrator + pattern skill. **New**: UI wiring, CWE view,
  provider selection per run.

### 5.3 Findings tab — the finding tracker
- Every promoted finding = a folder (`F-<n>-<slug>/`) with the report, quoted vulnerable
  source, remediation, evidence, and (if run) a live-validation transcript/PoC.
- Backed by `FINDING` graph nodes → linked to the exact feature, guard, pattern, and CWE.
- Status lifecycle tracked separately from outcome & verification (StaticCodeReview's
  4-orthogonal-field model): lifecycle · outcome · verification · assessment-mode.
- Export: HackerOne / Cobalt / generic (report-writing-skill).

### 5.4 Patterns tab — canonical + **your own patterns**
- Ships the 281 canonical cards (24 families) with CWE mapping.
- **Import a custom pattern folder** (the folder you attached is this): validate each card
  against the schema + registry, then **run a scan using only your patterns** (or merged).
- Pattern card schema (StaticCodeReview): invariant/goal · attacker control ·
  guard-to-sink differential · required proof · decisive rejection · overlaps.
- **Pattern mining**: after a scan, extract genuinely-new reusable patterns from the session
  into the catalog (feeds §5.6).

### 5.5 Env tab — test environment & live validation
- Register a target: base URL, auth, headers, scope, **explicit authorization flag**.
- Default mode is **STATIC_ONLY**; runtime/dynamic validation stays disabled until the
  project records authorization (StaticCodeReview already gates exactly this).
- After a candidate is confirmed statically, an optional **dynamic-validation step** exercises
  it against the live env; PoCs run inside a **self-contained sandbox** (container or WASM, no host FS).
- Result feeds the finding's `assessment-mode`: static-confirmed → runtime-confirmed.

### 5.6 Memory tab — self-learning across sessions & projects
- **Source of truth**: `memory/learned-patterns.md` + `feedback.jsonl` (files, git-diffable).
- **Recall**: an optional embedded vector index (`sqlite-vec`) over the store surfaces relevant
  priors from *any* past project before a scan — no external service.
- **Learning loop**: every accept/reject decision + every mined pattern updates the catalog and
  the router's weights; a scheduled consolidation dedups/prunes.
- "Improves day by day" = the catalog and recall corpus grow monotonically and are shared
  across all projects via the central store.

---

## 6. Multi-provider / model selection + effort

An **Engine Adapter** interface normalizes every backend to one job/result envelope, so the
whole pipeline is provider-agnostic:

```
interface EngineAdapter {
  map(job)        // run the mapping Lead/workers
  runAgent(job)   // run one hunter/triager/validator job envelope
  ask(query)      // cited Q&A over the store
}
```

- **Backends**: `claude-code` (Anthropic Agent SDK — default, auth via your local login),
  `codex`, `kimi` / any OpenAI-compatible endpoint, `gemini`, `cohere`, `ollama` (local).
- **Per-scan selection**: the Assess/Map UI picks **provider + model + effort** before a run;
  stored on the `ASSESSMENT_RUN` node for reproducibility.
- **Smart routing (optional)**: a thin SecForge router picks a cheaper model for low-complexity
  jobs and a stronger one for security/multi-file work, learning from outcomes. It routes across
  both vendors and per-vendor tiers, over the adapters.
- Default behavior = **your explicit choice**; routing is opt-in.

---

## 7. Tech stack (deliberately boring)

Inherit codengram's stack — zero-drama, dependency-light:
- **Node ≥ 22, ESM, npm workspaces** monorepo.
- **`node:sqlite`** for the graph (no native dep, single-file, atomic publish via rename).
- **`node:http`** loopback server + single-file UI (Host/Origin guard against DNS rebinding).
- **`@anthropic-ai/claude-agent-sdk`** for the default engine.
- **Python** stays for the assessment engine (StaticCodeReview's ~1,700-line
  `assessment_engine.py` + pattern/orchestrator CLIs) — **wrap it as a subprocess, don't
  rewrite it.** Port to Node later only if it measurably hurts. `// ponytail: subprocess the
  proven Python engine; port to Node only if the process boundary bites.`
- **Claude Design** for UI flows → exported static HTML.

### Repo layout (monorepo, mirrors codengram)
```
secforge/
  apps/cli            # secforge open|scan|ls|doctor|ask
  apps/server         # loopback UI server + forked scan workers
  apps/server/ui/     # Claude Design → static UI
  packages/store      # NEW: unified project store (extends codengram graph + security nodes)
  packages/map        # codengram engine (snapshot→graph→phase1-maps), guards removed
  packages/assess     # wrapper around StaticCodeReview Python engine
  packages/patterns   # canonical + custom pattern loading, CWE mapping
  packages/adapters   # NEW: engine adapters (claude-code/codex/kimi/…)
  packages/agents     # NEW: agent contracts (framer/hunter/triager/validator/reporter)
  packages/memory     # self-contained recall (sqlite-vec) + learned-patterns files
  packages/schemas    # extended node/edge/claim vocabulary + validators
```

---

## 8. Phased roadmap (build order — smallest useful thing first)

**Phase 0 — skeleton & store (make the truth durable).**
- Stand up the monorepo + `packages/store` (codengram graph + security node types + events.log).
- `secforge open` / `ls` / session binding. No AI yet.
- *Exit check*: open a repo twice → identical rehydrated state; nothing lives only in chat.

**Phase 1 — Map (vendor codengram).**
- Import codengram packages; strip recon-only guards; persist into the store; render `phase1-maps/`.
- Map tab + Coverage/QA audit.
- *Exit check*: a real repo maps feature-by-feature with cited evidence + a passing coverage gate.

**Phase 2 — Assess (wrap StaticCodeReview).**
- Subprocess the orchestrator; wire feature×pattern matrix + executor→verifier + coverage gates.
- Assess tab (targeted + full), Findings tab, CWE checklist.
- *Exit check*: targeted "access-control for feature X" produces a triaged, validated finding.

**Phase 3 — Patterns + Memory.**
- Custom pattern import + validation + custom-only scans; pattern mining.
- learned-patterns files + embedded (sqlite-vec) recall + the accept/reject learning loop.

**Phase 4 — Multi-provider + Env.**
- Engine adapters (claude-code first, then one OpenAI-compatible e.g. Kimi, then ollama).
- Per-run provider/model/effort selection; optional own tier router.
- Env tab + authorized dynamic validation in the sandbox.

**Phase 5 — polish**: large-scale fan-out for big repos, live progress streams,
scheduled consolidation, report exporters.

---

## 9. Decisions still open (need your call before Phase 2)

1. **Assess engine: subprocess Python vs port to Node.** Recommendation: subprocess now
   (don't rewrite proven code), revisit only if the boundary hurts.
2. **First non-Claude provider to support.** You mentioned Kimi — confirm it's the Phase-4
   priority over ollama/gemini.
3. **CWE mapping source.** Map the 24 pattern families → CWE by hand (accurate, one-time) vs
   auto. Recommendation: hand-map the 24 families; it's small and it's the checklist's spine.
4. **Semantic recall for v1.** Embedded `sqlite-vec` vs plain keyword recall. Recommendation:
   keyword for v1, add `sqlite-vec` when recall quality needs it.

---

## 10. What NOT to build (YAGNI)

- No new mapping engine — codengram is it.
- No new pattern DSL — the card schema + registry already exist and are validated.
- No new memory store as system-of-record — files + SQLite; embedded (`sqlite-vec`) recall is the accelerator.
- No cloud, no multi-tenant, no auth server — loopback, local, single-user (codengram's stance).
- No embeddings for the map itself — graph queries suffice; embeddings only for cross-project recall.
