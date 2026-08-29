# SecForge

A self-contained security-scanning workbench. Point it at a source tree; it maps the codebase
into a durable knowledge base, then runs tracked, feature-by-feature security assessments —
by pattern, by free-text prompt, or a full sweep — with a triage→validate pipeline that only
promotes real findings, CWE coverage, custom patterns, multi-provider model selection, and a
memory that improves over time.

**Self-contained.** The only heavy runtime dependency is the Claude Agent SDK. Sessions,
fan-out, lifecycle and memory are SecForge's own code over Node stdlib + SQLite. No external
orchestration runtime.

## Requirements

- Node ≥ 22 (uses ESM + `node:` builtins; `node:sqlite` for the graph in Phase 1)

## Quick start

```bash
npm install          # links the workspace packages (no network deps)
npm run serve        # → http://127.0.0.1:4770  (the workbench UI + API)
npm run doctor       # environment preflight
node apps/cli/bin/secforge.js open ~/code/some-repo   # open a project, start a session
node apps/cli/bin/secforge.js ls                       # list projects
```

The data store lives outside the source tree (default `~/.secforge/projects`, override with
`SECFORGE_DATA`). The **store is the source of truth** — every session/finding is on disk, so a
crash or restart loses nothing (`docs/SECFORGE-PLAN.md §0`).

## Layout

```
apps/
  cli/      secforge open|ls|status|resume|pause|cancel|doctor|serve
  server/   loopback UI server + JSON/SSE API   (public/ = the UI)
packages/
  schemas         graph vocabulary, envelopes, ids, session FSM states
  store           durable project store (files + events.log; sqlite graph in Phase 1)
  session         Session Manager + lifecycle FSM (scan = session)
  orchestrator    bounded-concurrency fan-out scheduler
  agents          framer / hunter / triager / validator / reporter roles
  adapters        engine backends (claude-code | codex | kimi | ollama)
  map             codebase → knowledge graph (our own snapshot → inventory → features)
  assess          hunt → triage → validate → report pipeline (Phase 2)
  patterns        canonical + custom patterns, CWE mapping
  memory          self-contained recall over the store
docs/             SECFORGE-PLAN · BACKEND-ARCHITECTURE · WIRING
```

## Status

Working v1, end-to-end and self-contained:
- **Store + sessions** — durable; a scan is a resumable session that rehydrates from disk.
- **Map** — real deterministic engine (snapshot → inventory → feature graph with `file:line` claims).
- **Assess** — real deterministic rule engine over the graph → triage → independent validate →
  findings + a feature × family coverage matrix. No LLM required.
- **Patterns** — 24 families / 281 canonical cards / 42 CWEs, vendored into the repo.
- **Memory / Env** — recall + learning; a guarded (static-only by default) test-target validator.
- **UI** — the workbench served at `/`, wired to the live API (health, projects, patterns,
  map graph, scan), with designed fallbacks.

Everything is SecForge's own code over Node stdlib + SQLite/files. **Future enhancement**: an
LLM adapter (Claude Agent SDK / OpenAI-compatible / Ollama) to augment the deterministic hunters,
and dynamic-validation transport hardening. See `docs/SECFORGE-PLAN.md` and `docs/WIRING.md`.

## License

MIT
