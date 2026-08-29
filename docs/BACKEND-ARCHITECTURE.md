# SecForge — Backend Architecture

> Status: DRAFT v0.2 · Companion to `docs/SECFORGE-PLAN.md` · Date: 2026-08-29
>
> SecForge ships **self-contained**: its only heavy runtime dependency is the **Claude Agent SDK**,
> alongside the reused codengram stack (`node:sqlite`, `node:http`) and the StaticCodeReview assess
> engine. It implements sessions, fan-out, lifecycle and memory itself — no external orchestration
> runtime, no MCP server. The on-disk **store is the source of truth**.

---

## 0. Two load-bearing ideas

1. **One scan = one session.** A scan is not a function call — it is a long-lived, resumable
   **session** (a local SDK session), bound to exactly one project, inside which **many agents
   fan out**. Open project X → session X; open project Y → a separate session Y.
2. **The session is a shell over durable state.** Every fact an agent produces is written to the
   store the moment it exists. Killing and reopening a session rehydrates it identically — the
   context window is a cache, never the record. (See `SECFORGE-PLAN.md §0`.)

---

## 1. What a Session *is* (the core model)

A **Session** is SecForge's own runtime binding of one scan — three self-implemented parts plus
one durable record. **No external orchestrator.**

```
Session
├── engine session   — a local Claude Agent SDK session, the reasoning context (provider-swappable)
├── orchestrator     — SecForge's own scheduler: fans out & fans in this scan's agents
├── lifecycle FSM    — SecForge's own state machine: created → running ↔ paused → done/cancelled
└── run record       — projects/<id>/assess/runs/<session-id>.json  (durable, in the store)
```

- **Bound 1:1 to a project.** One *active* session per open project; the project keeps a history
  of past session records, reopenable read-only.
- **Multi-agent by construction.** Within the session, agents (framer → hunters ×N → triager →
  validator → reporter) fan out as **Agent SDK subagents** driven by SecForge's orchestrator.
  The session is the *only* thing that crosses agents; agents share nothing but the store.
- **Resumable without any external runtime.** The lifecycle FSM + run record live in the store;
  resume = reload the record, re-open the engine session, re-dispatch unfinished jobs.
- **Isolated.** Source is a read-only frozen snapshot; agents only *read* it and *write* to the
  store, so parallel hunters cannot collide. Heavy write-tasks may take a scratch worktree.

```
        ┌──────────────────────── SESSION (scan run) ────────────────────────┐
        │  Claude Agent SDK session  ·  SecForge orchestrator  ·  lifecycle FSM │
        │                                                                     │
        │   framer ─┬─► hunter#1 ─┐                                           │
        │           ├─► hunter#2 ─┤                                           │
        │           ├─► hunter#3 ─┼─► triager ─► validator ─► reporter        │
        │           ├─► hunter#4 ─┤   (fan-in)                                │
        │           └─► hunter#5 ─┘                                           │
        │      (SDK subagents, bounded-concurrency scheduler — SecForge code) │
        └───────────────────────────────┬─────────────────────────────────────┘
                                         │ every result written immediately
                                         ▼
                       projects/<id>/  (store — source of truth)
```

---

## 2. Every concern, implemented *inside* SecForge

| Backend concern | SecForge's own implementation |
|---|---|
| **Scan lifecycle** (start/pause/resume/cancel/status) | A small **state machine** in `packages/session`, persisted to the run record. `created → running ↔ paused → completed/cancelled`. Resume reads the record. |
| **Agent fan-out** within a session | `packages/orchestrator` — a bounded-concurrency scheduler driving **Claude Agent SDK subagents** (one hunter per feature×pattern job). Plain async, no external fabric. |
| **Live progress** | Orchestrator emits an event stream → `apps/server` SSE. |
| **Per-agent isolation** | Read-only frozen source snapshot; agents write only to the store. Optional scratch git worktree for a write-heavy job. |
| **Inter-agent coordination** | In-process job queue + **result envelopes written to the store** (executor→verifier hand-off is a store record, not a live channel). |
| **Model + effort routing** | `packages/adapters` picks provider+model+effort per the user's choice; an optional thin rules router with weights learned into the store. All SecForge code. |
| **Execution backend** | Adapters: `claude-code` (Agent SDK, default) · `codex` · `kimi`/OpenAI-compat · `ollama`. One interface, provider-swappable. |
| **Memory / self-learning / recall** | The **store** (files + `index.sqlite`). Optional semantic recall via a **self-contained embedded vector index** (SQLite + `sqlite-vec`, or a tiny cosine over stored embeddings) — no external service. |
| **Dynamic PoC validation sandbox** | A self-contained sandbox for running PoCs against an authorised target — container or an embedded WASM runtime (decision §9). |

There is **no external orchestrator and no MCP dependency.** If a scan can't reach its LLM
provider it degrades gracefully to static-only.

---

## 3. Service / package architecture

```
secforge/  (Node ≥22, ESM, npm workspaces — see SECFORGE-PLAN §7)
  apps/cli               secforge open|scan|resume|status|ls|doctor
  apps/server            loopback UI server + JSON/SSE API (node:http)

  packages/session       ★ Session Manager — owns the Session model + lifecycle FSM (§1); only writer of run records
  packages/orchestrator  ★ fan-out scheduler over Agent SDK subagents (framer/hunter/triager/validator/reporter)
  packages/store         project store: index.sqlite graph + files + events.log (source of truth)
  packages/map           codengram engine — snapshot → graph → phase1-maps (guards removed)
  packages/assess        pipeline logic + coverage bijection + executor→verifier contracts
  packages/agents        agent role definitions (prompts, tools, job/result envelopes)
  packages/adapters      engine backends (claude-code | codex | kimi | ollama) behind one interface
  packages/memory        self-contained recall over the store (sqlite-vec / cosine) — optional
  packages/patterns      canonical + custom pattern loading, CWE mapping
  packages/schemas       node/edge/claim vocabulary + envelope schemas + validators
```

**Dependency rule:** the only external "engine" is the Agent SDK, reached solely through
`packages/adapters`. Everything else is SecForge's own code over Node stdlib + SQLite.

---

## 4. End-to-end scan-session flow

```
1. secforge open ~/code/acme-api
   └─ Session Manager: resolve projects/<id>/ → new session-id (no external preflight)

2. START SESSION  (packages/session)
   ├─ engine := adapters.open(provider, model, effort)     # Claude Agent SDK session
   ├─ fsm    := lifecycle.start(sessionId)                 # created → running
   └─ store.runs.write({sessionId, project, engine, status:'running'})

3. MAP        (packages/map — codengram)
   └─ snapshot → inventory → Lead+workers derive features → evidence-validate → index.sqlite → phase1-maps/

4. ASSESS     (packages/orchestrator fans out over the engine)
   framer  → scope job envelopes per feature×pattern
   hunters → orchestrator.parallel(jobs, bounded) → Agent SDK subagents          # fan-out
   triager → drops bogus (decisive-rejection controls)                            # store record
   validator → independent re-proof (cannot validate own work)                    # executor→verifier
   reporter → freezes validated records → store.findings + FINDING graph nodes
   ↳ each accept/reject + finding → packages/memory (store, ns security/feedback)

5. VALIDATE (optional)  (packages/agents + self-contained sandbox)
   authorised target → sandbox.run(poc) → verdict static→runtime-confirmed

6. LEARN   mine new patterns → patterns catalog + memory; periodic recall-index rebuild

7. END / PAUSE / RESUME
   pause  → fsm.pause()   (store holds all state)
   resume → fsm.resume()  → reload run record, re-open engine session, re-dispatch unfinished jobs
   done   → run record sealed; session reopenable read-only
```

Progress to the UI: orchestrator events → SSE. Steps 3–6 each write to the store before the next
reads — no fact lives only in an agent's context.

---

## 5. Session state the store persists

`projects/<id>/assess/runs/<session-id>.json`:

```jsonc
{
  "sessionId": "a1b2c3-07",
  "project": "acme-api", "revision": "a1b2c3",
  "engine": { "provider": "claude-code", "model": "claude-opus-4-8", "effort": "high" },
  "scope":  { "mode": "targeted", "feature": "checkout", "families": ["ACX"] },
  "status": "running|paused|completed|cancelled",
  "jobs":   [ { "id": "...", "role": "hunter", "state": "done|running|queued", "envelope": "..." } ],
  "coverage": { "matrixCells": 423, "verified": 330 },
  "checkpointedAt": "2026-08-29T..."
}
```

Plus candidates/findings as files + `VULN_CANDIDATE`/`FINDING` graph nodes, `events.log`
(append-only), coverage matrices. The run record is self-describing — no external checkpoint.

---

## 6. Concurrency, isolation, resume

- **Per-project isolation:** distinct `projects/<id>/`, distinct engine session. One active
  session per project (locked, §9), so no two scans write the same store concurrently.
- **Per-agent isolation:** hunters read the frozen snapshot and write only to the store; a
  bounded-concurrency scheduler (default N≈5) caps fan-out. Write-heavy jobs get a scratch worktree.
- **Resume semantics:** resume = reload the run record + re-dispatch jobs not marked `done`.
  Because every result is written on production, a crash loses at most one in-flight job.
- **No external-runtime failure mode:** there is no MCP server to lose; the only external call
  is to the LLM provider, whose loss degrades a scan to static-only, never corrupts the store.

---

## 7. Backend API surface (CLI/UI → backend)

Thin REST/JSON over the Session Manager — all served by SecForge itself.

| Route | Does |
|---|---|
| `POST /sessions` | open project → start session (lifecycle FSM) |
| `GET /sessions/:id` | status + jobs + coverage |
| `POST /sessions/:id/pause` · `/resume` · `/cancel` | lifecycle transitions |
| `POST /sessions/:id/scan` | run targeted/full assess → orchestrator fan-out |
| `GET /sessions/:id/stream` (SSE) | live progress from the orchestrator |
| `GET /projects/:id/findings` · `/coverage` · `/graph` | read the store |
| `POST /findings/:id/validate` | dynamic validation in the sandbox |

---

## 8. Build order (backend)

1. **`packages/session` + lifecycle FSM + run records** — open a session, persist, pause, resume.
   No agents yet. *Exit check:* kill mid-session, reopen → rehydrates with nothing lost.
2. **`packages/store`** — the SQLite graph + files + events.log (extend codengram's schema).
3. **Map** — wire codengram behind a session; stream to store.
4. **`packages/orchestrator` + Assess fan-out** — framer→hunters (Agent SDK subagents)→triager→
   validator→reporter; executor→verifier; findings to store.
5. **Adapters + routing** — provider/model/effort selection; optional learned router.
6. **`packages/memory` recall + Env validation** — self-contained recall; sandbox path.

---

## 9. Decisions

**Locked (2026-08-29):**
1. **SecForge is self-contained.** No external orchestration runtime or MCP dependency; the only
   engine is the Claude Agent SDK via `packages/adapters`. Sessions, fan-out, lifecycle and memory
   are all SecForge's own code. This supersedes the v0.1 design and `SECFORGE-PLAN §9.3`.
2. **One active session per project, history kept** (reopenable read-only).

**Still open:**
3. **Semantic recall library** — `sqlite-vec` vs a tiny hand-rolled cosine over stored embeddings
   vs SQLite FTS only. Recommend `sqlite-vec` (embedded, no service). Or skip embeddings for v1
   and use plain keyword recall.
4. **Sandbox for dynamic PoC validation** — ephemeral container vs embedded WASM runtime.
   Recommend a container the user opts into; keep static-only the default.
5. **Encryption at rest** for the store (holds vuln data) — recommend on by default.
