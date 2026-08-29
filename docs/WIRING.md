# SecForge — UI ↔ API ↔ package wiring map

Every UI surface maps to an API route (served by `apps/server`) which delegates to a package.
The UI (`apps/server/public/index.html`) currently renders with illustrative data; the routes
below are live in the skeleton (sessions/store real, engines stubbed) so wiring the UI's
`fetch()` calls to them is a mechanical follow-up, not a redesign.

| UI surface / action | API route | Package(s) | Status |
|---|---|---|---|
| Launcher → open / resume project | `POST /api/projects` | `session` → `store` | **real** |
| Launcher → recent projects list | `GET /api/projects` | `store` | **real** |
| Map tab → knowledge graph | `GET /api/projects/:id/graph` | `map` | **live** |
| Map tab → feature map / ledger / inventories / roles / consolidated | (served from `phase1-maps/` in store) | `map` → `store` | stub (Phase 1) |
| Assess → run screen → **Run assessment** | `POST /api/sessions/:id/scan?project=` | `session` + `assess` → `orchestrator` + `agents` + `adapters` | wired (engine stub, Phase 2/4) |
| Assess → scope picker (feature / pick / all) | request body `scope` | `schemas` (SCOPE_KINDS) | **real contract** |
| Assess → method (pattern / prompt / full) + pattern picker | request body `scope.method` / `scope.patterns` | `patterns` (families + CWE) | **real registry** |
| Assess → Live run pipeline (framer→…→reporter) | `GET /api/sessions/:id/stream` (SSE) | `orchestrator` (deterministic fan-out) | **real** |
| Assess → By feature / By CWE / Coverage matrix | `GET /api/projects/:id/coverage` | `assess` + `patterns` | stub (Phase 2) |
| Findings tab | `GET /api/projects/:id/findings` | `store` | **real** |
| Findings → Validate live | `POST /api/findings/:id/validate` | `env` (guarded, static-only by default) | **real** |
| Patterns tab (library + import) | `GET /api/patterns` · `GET /api/patterns/cards` · `POST /api/patterns/import` | `patterns` | **real registry** |
| Env tab (register target, authorise) | `GET`/`POST /api/projects/:id/env` | `env` (SSRF-guarded) | **real** |
| Memory tab (recall) | (Phase 3) | `memory` → `store` | **real keyword recall** |
| Session pause / resume / cancel | `POST /api/sessions/:id/{pause,resume,cancel}?project=` | `session` | **real** |
| Health check | `GET /api/health` | server | **real** |

## Package dependency direction (no cycles)

```
schemas  ← (everything imports the vocabulary)
store    ← session, memory, assess(via store), server, cli
session  ← server, cli
orchestrator ← assess
agents   ← assess
adapters ← assess
patterns ← assess, server
map      ← server, cli
memory   ← (server Phase 3)
```

`schemas` and `store` are the foundation; nothing depends on `server`/`cli` (the tops).
