// @secforge/recon/lead-methodology — the recon methodology the mapping Lead follows, as one
// SecForge-owned string (no file read at runtime, so a packaged install has nothing to lose).
// Mapping ONLY: it tells the Lead how to turn deterministic inventory clusters into source-grounded
// business features, actors, roles and permissions. It never asks for findings — the Assess tab
// does vulnerability work over the resulting map. Language/framework agnostic by design: every
// rule is about evidence shape, never about one stack's idioms.
export const METHODOLOGY = `
# Mapping methodology (read-only, static, any language)

## Operating rules — non-negotiable
1. NUMERICAL-FIRST. Counts before prose. Exact numbers, never "many".
2. CITE file:line FOR EVERY CLAIM. A feature, actor, role or permission with no real citation goes to "gaps".
3. READ, DON'T RUN. Static only. Never install, build, boot, or execute anything. Use only Read/Glob/Grep.
4. STOP WHEN PATTERNS REPEAT. After ~30 files in a directory you have seen its shape — sample, count, move on.
5. HONEST DEPTH. If you did not open a file, do not describe its behaviour. "gap" is a respected answer.
6. NOTHING DISAPPEARS SILENTLY. Every candidate cluster you were handed must land in a feature's selectors
   or be named in "gaps" with the reason.
7. NO SAMPLING ON SHARED CODE. A guard seen in one caller does not clear its siblings.
8. MAPPING, NOT HUNTING. Do not report vulnerabilities, severities, or exploitability. Describe what the
   code IS and WHO may act; a reviewer decides what is wrong later.

## What a FEATURE is
A coherent business capability a user, operator, or integration can recognise — "Expense approval",
"Session authentication", "Receipt OCR webhook" — NOT a file, class, directory, test, migration,
serializer, GraphQL type, or framework layer. A directory named "admin" or "api" is a LOCATION, not a
feature, until you have read what lives there. Merge clusters that implement one capability across
layers (a web controller + a GraphQL resolver + a worker + a policy for the same object are ONE feature).
Split a cluster that lumps unrelated capabilities. Prefer tens of durable capabilities over hundreds of
implementation nouns; prefer the domain language the code itself uses (model names, route nouns, policy
names, UI labels in production source).

Selectors are evidence-correlation rules, not semantics: give each feature distinctive include_paths /
include_symbols / include_entries / include_terms (and exclude_* to keep tests, docs, generated code and
shared infrastructure out). Use inventory_keys for an exact row ("kind:file:line:entry") when a selector
would be ambiguous. Cover every cluster without overlapping selectors where practical.

## How to work (any stack)
Stage A — Shape. Read the repository profile and the candidate clusters. Glob the top-level layout once.
  Identify the entry layers that exist here (web routes, REST, GraphQL, RPC, CLI, workers, events) and the
  data layer (models, stores, integrations). Do not assume a framework; look at what is declared.
Stage B — Roles first (the SUBJECT axis). Before naming features, find where identity is DEFINED in
  production/config source: role or access-level enums, membership models, permission/ability
  declarations, policy classes, guards, token types and their scopes. Specs, fixtures, docs, assets,
  translations and generated code may corroborate but never establish a role, actor or permission.
Stage C — Features (the OBJECT axis). For each candidate cluster, open 2–6 representative files from its
  samples and decide: which capability is this, does it merge with a neighbour, does it split. Name the
  main business objects. Write a one-paragraph purpose grounded in what you read.
Stage D — Wiring. For each feature list the grounded permission names that govern it and the actors
  that can reach it. Keep operation/resource granularity (read vs create vs update vs delete when the
  source separates them); never collapse to a vague "access".
Stage E — Gaps. Name every cluster you could not ground, every role you suspected but could not
  establish, every layer the inventories missed. A gap is information, not failure.

## Identity model — keep the three axes separate
- ACTOR: an independent security principal that can authenticate, hold credentials, or be the subject of
  an authorization decision (human user, API token, service account, system, external integration).
  Internal classes, workers, validators, middleware and infrastructure are architecture, NOT actors.
- ROLE: a privilege level assigned to principals (member, admin, owner, access level 30…), established
  only by an authoritative definition in production or config source.
- PERMISSION: a resource + operation grant (read_issue, expense:approve) declared by a policy rule,
  ability declaration, authorization call, permission constant or access-control config, with at least
  one grounded grantee (a role or an actor).
- A guard, validation rule, rate limit, CSRF check, origin check or safety invariant is a CONTROL, never a
  permission and never a role.

## Evidence
Every evidence item is { file, line, symbol?, reason } where file is a repository-relative path you
actually opened or grepped in THIS tree, line is a real 1-based line in it, and symbol (when given) is an
identifier that appears on or near that line. Anything else is rejected by the validator and the entity
is dropped — so cite only what you saw.
`;
