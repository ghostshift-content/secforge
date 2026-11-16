# SecForge — UI ↔ API ↔ package wiring map

Every UI surface maps to an API route (served by `apps/server`) which delegates to a package.
The UI is `apps/server/public/index.html` plus two Map-tab modules it loads: `map-graph.js`
(system graph + feature flow, hand-rolled SVG) and `map-views.js` (Features/Interfaces/Identity/
Coverage/Export tables and the 13-section feature document). Every pane renders real store data
or an explicit empty state.

| UI surface / action | API route | Package(s) | Status |
|---|---|---|---|
| Launcher → open / resume project | `POST /api/projects` | `session` → `store` | **real** |
| Launcher → recent projects list | `GET /api/projects` | `store` | **real** |
| Map tab → Graph (radial system brain + per-feature layered flow, `public/map-graph.js`) | `GET /api/projects/:id/graph` · `/reconciliation` · `/features/:fid/context` | `map` · `retrieval` | **live** |
| Map tab → Features / Interfaces / Identity / Coverage tables (`public/map-views.js`) | `GET /api/projects/:id/graph` · `/reconciliation` (counts + gaps + full `rows`) | `map` → `store` | **live** |
| Map tab → Feature map (the 13-section document) | `GET /api/projects/:id/features/:fid/map` | `map` (`renderFeatureDoc`) | **live** |
| Map tab → Export (the `phase1-maps/` bundle written per snapshot) | `GET /api/projects/:id/maps` · `GET /api/projects/:id/maps/<path>` | `map` (`renderPhase1Maps`) | **live** |
| Map → semantic layer (agentic Lead reads the FROZEN snapshot with Read/Glob/Grep) | `POST /api/projects/:id/map` `{engine, model, effort}` | `recon` (`lead.js`) → `adapters` (`explore`) | **live** for `claude-code` / `codex`; one-shot `ask` for other engines |
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
