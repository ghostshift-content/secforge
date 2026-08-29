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
  map             codebase → knowledge graph (vendors codengram, Phase 1)
  assess          hunt → triage → validate → report pipeline (Phase 2)
  patterns        canonical + custom patterns, CWE mapping
  memory          self-contained recall over the store
docs/             SECFORGE-PLAN · BACKEND-ARCHITECTURE · WIRING
```

## Status

Phase 0 skeleton: session lifecycle + store are real and durable; the map/assess engines and
the LLM adapter are shaped stubs wired end to end. See `docs/SECFORGE-PLAN.md` for the roadmap
and `docs/WIRING.md` for how the UI maps to the API and packages.

## License

MIT
