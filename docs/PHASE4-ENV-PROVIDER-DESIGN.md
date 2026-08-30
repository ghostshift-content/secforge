# Phase 4 — Multi-provider + Env: Honest Gap Analysis & Design

> Status: DRAFT · Design only, nothing in this doc is implemented yet.
> Scope: SECFORGE-PLAN.md §5.5 + §6, §8 Phase 4; BACKEND-ARCHITECTURE.md §9.4/§9.5.
> Constraints: Node ≥23.4 ESM, npm workspaces, stdlib only (`node:crypto` is fine), deterministic
> core, no build-tooling traces in the product, no external deps.

---

## 1. Gap analysis

| # | Element | Verdict | Evidence |
|---|---|---|---|
| 1 | Provider select | **BUILT** | `packages/adapters/src/index.js:334-347` `listEngines()`; `apps/server/src/routes.js:80-83` `GET /api/engines`; `apps/server/public/index.html:951-1002` `paintPicker()`/`renderEngineSelects()`. |
| 2 | Model select | **PARTIAL** | UI dropdown is real (`index.html:940-964`) and the choice reaches the run record and `finding.engine` (`routes.js:240`, `packages/assess/src/index.js:47`). But the *effect* is only real for the `codex` adapter, which reads `opts.model` (`adapters/index.js:217-220`). For `openai`/`anthropic`/`ollama`, `askRaw` hardcodes its model from an env var (`adapters/index.js:123,147`), and the call site `adapter.ask(buildPrompt(batch), { model })` (`assess/index.js:192`) passes that model to `ask(prompt)`, whose signature (`makeAdapter()`, `adapters/index.js:42-48`) takes **one** argument — the second argument is silently dropped by JS. So a user picking a non-default model for openai/anthropic/ollama today has **no effect** on what actually runs, and nothing in the response says so. |
| 3 | Effort select | **MISSING** | No `state.effort` in the UI, no effort control next to the model dropdown, not in the scan POST body (`index.html:1468`: `{ scope, engine, model }`), not read in `routes.js`, not a parameter of `runAssessment()`, not in `finding.engine` (`assess/index.js:47`: `{ provider, model }` only). The only occurrences of "effort" anywhere in code are decorative/inert: the hardcoded placeholder text `"Claude · opus · high"` on the top pill (`index.html:213`, overwritten the instant `loadEngines()` runs and never reflects a real choice) and a fallback default `effort: 'high'` in `packages/session/src/index.js:25` that is never read by `recordEngine()` (`routes.js:245` always writes `{ provider, model, requested, reason }`, no `effort` key). |
| 4 | Per-run reproducibility record | **PARTIAL** | The run record (`packages/session/src/index.js` `recordEngine`) and `finding.engine` capture `{provider, model}` (plus `requested`/`reason` on the run) — reproducible for provider/model. Effort is never recorded, so a past run cannot be told "what effort was asked for" because it was never asked. |
| 5 | Env register/authorize | **BUILT** | `packages/env/src/index.js:13-32` `registerTarget()`; `apps/server/public/index.html` Env tab (`~1899-1945`); `POST`/`GET /api/projects/:id/env` (`routes.js:124`, `175-178`). |
| 6 | Static-only default | **BUILT** | `authorized` defaults `false` (`env/index.js:13,25`); `validateFinding()` short-circuits with `{ran:false, reason:'not authorized (static-only)'}` unless `target.authorized` (`env/index.js:55-57`). |
| 7 | Guarded dynamic GET | **BUILT (library) / effectively unreachable (UI)** | `env/index.js:63-86`: single `GET`, `redirect:'manual'`, 5s `AbortController` timeout, SSRF blocklist (loopback/metadata/`.internal`, override only via `SECFORGE_ALLOW_INTERNAL=1`). But the UI's only caller, `findValidateBtn`, always posts `{ dryRun: true }` (`index.html:1677`) — there is **no UI affordance today that ever sets `dryRun:false`**. The guarded GET is real and tested (`packages/env/src/demo.js`) but currently unreachable end-to-end from a human clicking "Validate live". |
| 8 | PoC sandbox | **MISSING, and doc-claimed** | `grep -rn "sandbox\|Sandbox\|WASM"` over `packages/` and `apps/` returns nothing — zero sandbox code exists. But `SECFORGE-PLAN.md:253` and `BACKEND-ARCHITECTURE.md:76,221-222` explicitly promise "PoCs run inside a **self-contained sandbox** (container or WASM, no host FS)". This is the live overclaim: docs describe a capability the product does not have. This is the exact class of fabrication (S1) that must not reach the UI or the docs as a real affordance. |
| 9 | Encryption at rest | **MISSING** | `packages/store/src/index.js` `readJSON`/`writeJSON` (`:19-29`) do plain `JSON.stringify`/`JSON.parse`; `crypto` is imported only for `projectId` hashing and temp-file randomness (`:9,17,26`), never to encrypt content. `registerTarget()` writes `authHeader`/`extraHeaders` straight to `env/target.json` in plaintext (`env/index.js:20-27`). Findings are also plaintext (`store/index.js:103-108`) — expected, see §4 below for why that's fine to leave alone. |

---

## 2. Effort selection — design

### 2.1 What it is, honestly

Effort is a **recorded, best-effort knob**, not a universal behavior switch. It threads through
the whole pipeline for reproducibility (item 4 above), and it has a real, verifiable effect on
the two things in this codebase that already have an effort-shaped knob: the **per-call token
budget** and the **candidate cap** of the optional LLM-assist HUNT step. For everything else
(the deterministic rules engine, and any adapter whose `analysis` is `'rules-only'`) it is
**inert by design** — recorded on the run and on every finding it produced, changing nothing.
The UI must say so, not imply otherwise.

Levels: `'low' | 'medium' | 'high' | 'max'`, default `'medium'`.

### 2.2 Threading (additive at every hop)

```
UI effort <select>  →  state.effort
  → POST /sessions/:id/scan  body: { scope, engine, model, effort }
    → routes.js: validEffort(body.effort) → 'low'|'medium'|'high'|'max' (else 'medium')
      → mgr.recordEngine(project, sid, { provider, model, requested, reason, effort })   // run record, additive field
      → runAssessment({ ..., effort })
        → llmAssist(graph, engine, candidates, model, effort)
          → adapter.ask(prompt, { model, effort })
        → findingOf(candidate, n, engineUsed, model, effort)
          → finding.engine = { provider, model, effort }   // additive field
```

- `packages/session`: `recordEngine()` signature is unchanged (it already takes a plain object);
  `session.engine` simply gains an `effort` key. No schema migration — old run records without
  it read back as `effort: undefined`, which callers must treat as "not recorded" (pre-Phase-4
  run), never coerce to a level.
- `packages/assess/src/index.js`: `runAssessment()` gains an `effort = 'medium'` parameter;
  `findingOf()` gains an `effort` parameter and adds it to `finding.engine`. Both additive —
  every existing caller (including `packages/assess/src/demo.js`) keeps working unchanged.
- `packages/adapters/src/index.js`: `EFFORT_BUDGETS = { low: 512, medium: 1024, high: 2048, max: 4096 }`
  (token-budget constant, exported for the UI/tests to assert against). `askRaw` for `anthropic`
  (`max_tokens`), `openai` (`max_tokens`), and `ollama` (`options.num_predict`) read
  `opts.effort` and set the real request field from `EFFORT_BUDGETS`. `codex`'s `ask(prompt, opts)`
  already threads `opts` through — extend it to also pass effort through if/when a real,
  *verified* Codex CLI flag exists for it (see 2.4); until verified, codex effort is
  recorded-only, same as rules/claude-code/gemini.
- `packages/assess/src/index.js` `llmAssist()`: `LLM_CAP` becomes effort-scaled
  (`{low:5, medium:10, high:15, max:20}`) — this is the second real, honest behavior: effort
  also bounds how many extra LLM-nominated candidates the assist step is allowed to surface.

### 2.3 Drive-by fix this depends on (root cause, not a new bug)

`makeAdapter()`'s `ask(prompt)` (`adapters/index.js:33-48`) must become `ask(prompt, opts = {})`
and pass `opts` to `askRaw(prompt, opts)`, and `openaiAskRaw`/`anthropicAskRaw`/`ollamaAskRaw`
must accept `(prompt, opts = {})` and read `opts.model`/`opts.effort` (falling back to the
existing env-var defaults when absent). This is the single chokepoint every non-codex LLM
adapter's `ask()` goes through — fixing it there, once, is what makes **both** model selection
(item 2, currently partial) and the new effort knob actually real for openai/anthropic/ollama,
instead of adding effort on top of a call path that already silently drops its options object.
Skipping this fix would mean shipping effort as another item that *looks* wired in the UI but
does nothing for three of the four wired LLM adapters — exactly the kind of overclaim this phase
is supposed to remove, not add.

### 2.4 What is explicitly NOT claimed

- No "reasoning mode" / thinking-budget mapping for Anthropic, no `reasoning_effort` param for
  OpenAI-style models. Those may be real provider features, but this design has not verified
  their current API shape against a live account, and fabricating a parameter that silently
  gets ignored (or worse, rejected as an unknown field) is exactly the failure mode being fixed
  in 2.3. Token-budget scaling is the only claim made because it is a documented, universally
  supported field on all three HTTP-based adapters already in this codebase.
- No effort effect for `rules`, `claude-code`, `gemini` (both CLI adapters are `analysis:
  'rules-only'`/unwired — see `adapters/index.js:301`) — the UI's effort control must be
  disabled (or clearly badged, mirroring the existing "Connected · analysis not wired" badge
  pattern at `index.html:968`) whenever the selected engine can't act on it, exactly like the
  model dropdown already does for connection state.
- No per-job/per-hunter effort variation, no smart effort auto-selection. One effort value per
  scan, chosen by the user, recorded as asked.

---

## 3. Dynamic validation / sandbox — honest scoping

### Decision: **Option (a)** — keep the guarded single read-only GET as the entirety of "dynamic
validation"; formally drop the sandbox claim from the docs.

**Why not (c) a real sandbox:** a container or embedded-WASM PoC-execution sandbox is a
large, security-sensitive subsystem — untrusted-code isolation, network egress control, resource
limits, escape-proofing — that this codebase has zero infrastructure for today (no container
runtime dependency, no WASM runtime, stdlib-only constraint). Building a *fake* version of it
(e.g. a `vm` module sandbox, or a subprocess with `spawn` and a prayer) would be worse than not
building it: it would look like isolation and not be isolation, which is precisely the kind of
overclaim (an S1 fabrication) this task exists to prevent. There is also no current usage
pressure for it — the UI does not even expose a way to run a *real* GET yet (item 7), let alone
execute an arbitrary PoC body.

**Why not (b) a minimal opt-in bounded probe either, for now:** the existing guarded GET already
answers the only question dynamic validation needs to answer today — "is this route reachable
and does it respond as the static finding implies" (reachable / not-reachable / error). A bounded
probe that also, say, sends a scoped payload or checks a response body pattern is a real,
buildable next step, but it is speculative until someone hits the wall of "reachable isn't
enough, I need to see it actually exploited" — YAGNI until then. Note it as the natural v2 if
that need shows up; do not build it now.

**What to build in Phase 4 (small, honest, code-only):**

1. Make the guarded GET reachable from the UI. Today `findValidateBtn` always sends
   `{dryRun:true}` (`index.html:1677`) — add a confirmation step (the target is
   already-authorized, so this is a UX gate, not a new authorization check) that lets the user
   flip to a real `dryRun:false` call, showing the exact URL that will be hit before they
   confirm (`validateFinding()`'s `dryRun:true` path already returns `wouldGet` for exactly this
   purpose — `env/index.js:65`).
2. Rename the concept everywhere it is user-facing from "sandbox" to what it is: **"live
   validation"** or **"authorized reachability check"**. It performs one read-only GET against a
   target the project owner explicitly authorized, nothing more.
3. **Documentation fix (required, not optional):** update `SECFORGE-PLAN.md §5.5` ("PoCs run
   inside a self-contained sandbox (container or WASM, no host FS)") and
   `BACKEND-ARCHITECTURE.md §2` row "Dynamic PoC validation sandbox" and `§9.4` to say plainly:
   *dynamic validation is a single guarded, authorized, read-only GET — no PoC code execution, no
   sandbox.* If a real sandbox is ever built, it is a separate, explicitly-scoped project with its
   own threat model, not a Phase 4 line item.

**What NOT to build now, and why:**
- No container runtime, no embedded WASM engine, no `vm`/`vm2`/subprocess-based pseudo-sandbox.
- No arbitrary PoC code execution of any kind — user-supplied JS/HTTP-sequence scripts included.
- No expansion of `validateFinding()` beyond the current single read-only GET (no write methods,
  no multi-step probes, no payload injection) until a concrete, demonstrated need exists.

---

## 4. Encryption at rest

### 4.1 Scope: secrets only, not the whole store

Encrypt exactly the two secret-bearing fields in `env/target.json`: `authHeader` and
`extraHeaders`. Findings, run records, the graph, and events stay plaintext files, because:
- They are the product's actual output — the user greps, exports (H1/Cobalt), and diffs them.
  Encrypting them breaks every one of those workflows for a benefit that doesn't exist: they
  aren't credentials, they're the vulnerability data the user *asked SecForge to produce and
  show them*.
- They sit under the same OS-permission boundary as the key material this design proposes below
  anyway (see 4.3) — encrypting them would add cost without adding a real security boundary,
  since anyone who could decrypt them can already read the plaintext files sitting next to the
  key.
- Full-store encryption was flagged as "open" in `BACKEND-ARCHITECTURE.md §9.5` — this design
  closes it by scoping down to secrets, and says so explicitly rather than silently expanding
  scope later.

### 4.2 Format (additive, transparent to readers)

`target.json` today:
```jsonc
{ "baseUrl": "...", "authHeader": "Bearer xxx", "extraHeaders": {"X-Api-Key":"..."}, "scope": [...], "authorized": true, "updatedAt": "..." }
```

New shape — `authHeader`/`extraHeaders` become encrypted envelopes when set, `null`/`{}` stay as
they are (nothing to encrypt):
```jsonc
{
  "baseUrl": "...",
  "authHeaderEnc":   { "v": 1, "iv": "<base64,12B>", "tag": "<base64,16B>", "ct": "<base64>" } | null,
  "extraHeadersEnc": { "v": 1, "iv": "<base64,12B>", "tag": "<base64,16B>", "ct": "<base64>" } | null,
  "scope": [...], "authorized": true, "updatedAt": "..."
}
```
`scope`, `baseUrl`, `authorized` stay plaintext — they aren't secret and the UI/`inScope()` logic
needs to read `scope` without touching key material.

- `registerTarget()`: encrypt `authHeader` (a string, or `null`) and `extraHeaders` (an object,
  JSON-stringified then encrypted as one blob — no per-header-value granularity; header *names*
  aren't secret, only values might be, and splitting adds complexity for no real gain — YAGNI) with
  AES-256-GCM (`node:crypto` `createCipheriv('aes-256-gcm', key, iv)`), a fresh random 12-byte IV
  per write, and the GCM auth tag stored alongside the ciphertext.
- `getTarget()`: decrypt-on-read. Returns the **same shape callers already use**
  (`{baseUrl, authHeader, extraHeaders, scope, authorized, updatedAt}`) — `validateFinding()` and
  the UI's env-hydration code (`index.html:1900-1907`, which already deliberately never echoes
  `authHeader` back to the DOM) need zero changes. Decryption failure (corrupt file, wrong/rotated
  key) must not crash the read path — return `authHeader:null, extraHeaders:{}` for that target
  and log/flag it, the same posture as a missing file today (`env/index.js:36`).
- **Legacy read compatibility:** a `target.json` written before this change has plaintext
  `authHeader`/`extraHeaders` keys, not `*Enc`. `getTarget()` checks for the encrypted key first,
  falls back to the plaintext key if present (treats it as already "decrypted"), so nothing
  breaks on upgrade. The next `registerTarget()` call rewrites the file in the new encrypted
  shape — this is a **lazy, natural migration**, not a batch script, because `registerTarget()`
  already rewrites the whole file on every save (`env/index.js:28-31`).

### 4.3 Key management — the honest story

- **Where the key comes from:** a 32-byte random key generated on first use and written to
  `~/.secforge/keyring/env.key` (mode `0600`), OR — if `SECFORGE_ENV_KEY` (base64, 32 bytes) is
  set in the environment — that value is used instead and the key file is never created. This
  mirrors the existing `SECFORGE_DATA`-root override pattern already used by `packages/store`
  (`store/index.js:14`).
- **What this protects against:** the store directory (`~/.secforge/projects/**`) being read,
  copied, or exfiltrated *separately* from the keyring — e.g. it ends up in an unrelated backup,
  a support bundle, a `~/.secforge/projects` directory synced to somewhere less protected than
  `$HOME`, or someone greps a findings export bundle that happened to bundle the raw project
  directory. In those scenarios the credentials are ciphertext, not plaintext.
- **What this does NOT protect against, and must never be claimed to:**
  - Anyone with read access to the same local user account/filesystem as the running process —
    they can read the key file exactly as easily as they could have read plaintext credentials.
    This is **not** a secrets-manager, OS-keychain, or HSM-backed design; it is a machine-local
    file next to another machine-local file.
  - Root/administrator access on the host.
  - A live memory dump of the SecForge process (the key and decrypted secret both exist in
    memory while `getTarget()`/`validateFinding()` run).
  - A compromised SecForge process itself (it holds the key by construction — it has to, to do
    its job of making an authorized authenticated request on your behalf).
  - Anyone who already has `SECFORGE_ENV_KEY` from wherever it's set (shell history, CI secret
    store, process environment of a co-located process) — the env-var path is a convenience for
    scripted/CI use, not a stronger guarantee than the file path.
- **One-line summary for the UI/docs:** "credentials are encrypted at rest against casual
  disclosure of the data files alone; they are not protected from anyone who can already read
  files as your user account." This sentence (or one materially like it) must appear anywhere
  this feature is described — no bare "encrypted" badge without it.

---

## 5. API / shape impact — additive only

| Surface | Before | After | Compat |
|---|---|---|---|
| `POST /sessions/:id/scan` body | `{ scope, engine, model }` | `{ scope, engine, model, effort? }` | `effort` optional, defaults to `'medium'` server-side. |
| Run record `session.engine` | `{ provider, model, requested, reason }` | `+ effort` | Old records simply lack the key; readers must not assume it exists. |
| `finding.engine` | `{ provider, model }` | `+ effort` | Same — additive key, absent on findings from pre-Phase-4 runs. |
| `GET/POST /api/projects/:id/env` response/body shape | `{ baseUrl, authHeader, extraHeaders, scope, authorized, updatedAt }` | **unchanged** — encryption is internal to `env/target.json` on disk; `getTarget()` still returns plaintext `authHeader`/`extraHeaders` to callers (decrypt-on-read) | Fully transparent; no UI or route change required for encryption itself. |
| `POST /api/findings/:id/validate` | `{ dryRun }` → `{ran, reason?, wouldGet?, status?, verdict?}` | **unchanged** | UI change is only in *when* it sends `dryRun:false`, not the contract. |

Nothing here breaks an existing consumer; every change is a new optional field or an on-disk
format swap fully hidden behind the existing `getTarget()`/`registerTarget()` functions.

---

## 6. Test plan

Follow the repo's existing convention: a `node:assert` `src/demo.js` self-check per package, plus
`node:test` files under `test/`.

- **`packages/adapters`**
  - `EFFORT_BUDGETS` maps all four levels to increasing token budgets.
  - `makeAdapter().ask(prompt, {model, effort})` forwards both into `askRaw` (assert via a fake
    `askRaw` spy) — covers the 2.3 drive-by fix directly.
  - `anthropicAskRaw`/`openaiAskRaw`/`ollamaAskRaw`: with a stubbed `fetch`, assert the outgoing
    request body's `max_tokens`/`num_predict` matches `EFFORT_BUDGETS[effort]`, and defaults to
    `EFFORT_BUDGETS.medium` when `effort` is omitted.
  - An invalid/unknown effort string never throws — falls back to `'medium'`.
- **`packages/assess`**
  - `runAssessment({..., effort:'max'})` → resulting `finding.engine.effort === 'max'`.
  - `runAssessment()` with no `effort` → `finding.engine.effort === 'medium'` (default), and a
    `rules`-engine run's findings are byte-identical whether `effort` is `'low'` or `'max'` (the
    "inert for the deterministic engine" claim, asserted, not just stated).
  - `llmAssist()`'s effective `LLM_CAP` changes with effort (assert candidate count ceiling per
    level using a stub adapter that returns more than the cap).
- **`packages/env`**
  - `registerTarget()` followed by a raw `fs.readFile` of `target.json` asserts `authHeader`
    never appears as plaintext in the file when a value was supplied, and `authHeaderEnc.iv`/`.tag`/`.ct`
    are all present base64 strings.
  - `getTarget()` round-trips: register with a secret header → read back → `authHeader` matches
    the original plaintext value.
  - Legacy-format read: hand-write a `target.json` with the old plaintext `authHeader` key (no
    `Enc` suffix) → `getTarget()` still returns it correctly.
  - Corrupt/undecryptable envelope (wrong key, or a tampered `tag`) → `getTarget()` does not
    throw; returns `authHeader:null` (matches existing missing-file behavior).
  - `validateFinding()`'s full guarded-GET path is unaffected by encryption (existing
    `env/src/demo.js` behavior — the network-guard tests — must still pass unchanged).
- **`apps/server` routes**
  - `POST /sessions/:id/scan` with `effort` present is recorded on the run (`GET
    /sessions/:id` reflects it) and on every finding from that scan.
  - Omitting `effort` still 200s and defaults to `'medium'` (backward compatibility with any
    existing script/test that posts the old body shape).
- **UI (manual/smoke, no test framework added — matches existing UI test posture in this repo)**
  - Effort select next to the model select, disabled/badged exactly like the model select is for
    a not-connected or `analysis!=='llm'` engine.
  - "Validate live" shows the target URL and requires a second confirmation before ever sending
    `dryRun:false`.

---

## 7. Explicit NOT-building list (YAGNI)

- **Smart tier-router** (SECFORGE-PLAN §6 "Smart routing (optional)", BACKEND-ARCHITECTURE §9
  open item 3-adjacent) — an auto-selecting cost/quality router across providers/tiers. Opt-in,
  defer indefinitely; nothing in the current usage pattern (one explicit user choice per scan)
  needs it, and it would need real outcome data this codebase doesn't collect yet.
- **Any container/WASM PoC sandbox** — see §3. Not built, and the docs claiming it exist today
  must be corrected, not left standing.
- **Provider-specific "reasoning mode" mapping** (Anthropic extended thinking, OpenAI
  `reasoning_effort`) — see §2.4. Not claimed until verified against a live, current API surface;
  token-budget scaling is the only behavioral claim made for effort.
- **Full-store encryption** — see §4.1. Scoped to `authHeader`/`extraHeaders` only; findings,
  runs, graph, and events stay plaintext, deliberately, with the reasoning stated so it isn't
  mistaken for an oversight later.
- **OS-keychain / secrets-manager integration** for the encryption key — a machine-local key
  file (or env var) is the entire key-management story for this phase. A real secrets-manager
  integration is a bigger, platform-specific project with its own design; this phase does not
  claim to be that.
- **Per-header-value encryption granularity** in `extraHeaders` — the whole object is one
  ciphertext blob; header names were never secret and splitting adds real complexity (a schema,
  a migration story per key) for no demonstrated benefit.
- **Expanding `validateFinding()` beyond one read-only GET** (payload injection, multi-step
  probes, non-GET methods) — no demonstrated need yet; the "minimal opt-in bounded probe" option
  is named as the natural v2, not built now.

---

## 8. Summary

- **Genuinely worth building now:** (1) effort passthrough end-to-end, bundled with the small
  root-cause fix to `makeAdapter().ask()` that makes both effort *and* the already-partial model
  selection actually real for openai/anthropic/ollama; (2) secrets-at-rest encryption for
  `env/target.json`'s `authHeader`/`extraHeaders`, AES-256-GCM via `node:crypto`, machine-local
  key, decrypt-on-read, with the threat model stated plainly wherever it's surfaced; (3) an
  honest resolution of the sandbox claim — keep the existing guarded single read-only GET, make
  it actually reachable from the UI (today it isn't — `dryRun` is hardcoded `true`), rename
  "sandbox" to "authorized reachability check" everywhere, and fix the two doc sections that
  currently promise a container/WASM sandbox that does not exist.
- **Deliberately not building:** the smart tier-router, any real or fake PoC-execution sandbox,
  full-store encryption, OS-keychain integration, provider-specific reasoning-effort API mapping,
  and any expansion of dynamic validation past one read-only GET — each for a stated reason, not
  silently dropped.
