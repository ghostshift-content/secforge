// @secforge/recon/ai-semantic — planClusters(): SecForge's one-shot re-implementation of codengram's planRecon
// contract (packages/claude-runtime/index.js), adapted to a stateless HTTP adapter with no filesystem/tool access
// (docs mapper-design.md §0/§5). The model only ever sees what we put in the prompt string; it cannot re-open a
// file to check itself. So every sample handed to the model is a literal {kind, file, line, entry} it may legally
// cite back, and evidence-validator.js (not this file) is the actual gate that decides what survives.
//
// planClusters() takes the adapter as a parameter (dependency-injected) — it never constructs one — so callers
// (and tests) can pass any object shaped like { ask(prompt, opts) => Promise<string> }.

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));
const uniq = (values) => [...new Set((values || []).filter((x) => x != null && String(x).trim() !== ''))];
const itemKey = (value) => JSON.stringify(value);
const uniqObjects = (values) => {
  const seen = new Set();
  return (values || []).filter((value) => {
    const key = itemKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Turn deterministic technical clusters (shape: { slug, domain, name, rows: [{ kind, row }] }, as produced by
// semantic-planner.js's deterministicSemanticPlan) into a bounded prompt-ready summary. Unlike codengram's own
// summarizeClusters (whose sample strings drop the line number — fine when the model can re-open the file itself),
// every sample here is a structured { kind, file, line, entry } triple: the literal thing a one-shot model is
// allowed to cite back in its evidence.
export function summarizeClusters(clusters, { maxClusters = 400, samplesPerCluster = 4 } = {}) {
  const top = (clusters || []).slice(0, maxClusters);
  return top.map((c) => {
    const rows = c.rows || [];
    const kinds = {};
    for (const { kind } of rows) kinds[kind] = (kinds[kind] || 0) + 1;
    const dirs = new Set();
    for (const { row } of rows) {
      const p = String(row?.file || '').split('/').slice(0, 3).join('/');
      if (p) dirs.add(p);
      if (dirs.size >= 6) break;
    }
    const samples = rows.slice(0, samplesPerCluster).map(({ kind, row }) => ({
      kind, file: row?.file, line: row?.line ?? null, entry: String(row?.entry || row?.file || '').slice(0, 160),
    }));
    return { slug: c.slug, domain: c.domain, name: c.name, row_count: rows.length, kinds, paths: [...dirs], samples };
  });
}

const RESPONSE_SHAPE = `Respond with ONLY a single JSON object (no prose, no markdown fences, no commentary) matching
this exact shape (omit a field entirely rather than inventing a value for it):
{
  "features": [{ "name": "string", "slug": "string", "domain": "string", "purpose": "string",
    "include_paths": ["string"], "include_terms": ["string"], "include_symbols": ["string"],
    "include_entries": ["string"], "inventory_keys": ["string"], "exclude_paths": ["string"],
    "exclude_terms": ["string"], "confidence": "high|medium|low", "actors": ["string"], "permissions": ["string"],
    "evidence": [{ "file": "string", "line": 1, "symbol": "string", "reason": "string" }] }],
  "actors": [{ "name": "string", "kind": "human|token|service|system|integration", "obtained_via": "string",
    "scopes": ["string"], "hierarchical": false, "evidence": [{ "file": "string", "line": 1 }] }],
  "roles": [{ "name": "string", "description": "string", "scope": "string", "obtained_via": "string",
    "hierarchical": false, "enables": ["string"], "evidence": [{ "file": "string", "line": 1 }] }],
  "permissions": [{ "name": "string", "description": "string", "resource": "string", "operation": "string",
    "enabled_by_roles": ["string"], "granted_to_actors": ["string"], "evidence": [{ "file": "string", "line": 1 }] }],
  "relationships": [{ "from": "string", "to": "string", "kind": "string" }],
  "gaps": ["string"]
}`;

// Prompt body: codengram's planRecon rules list (claude-runtime/index.js:434-460), reused near-verbatim, with the
// two one-shot-specific adjustments the design calls out: no tool access, and a plain-JSON response contract.
function buildPrompt(summarizedClusters) {
  return `You are a one-shot semantic-mapping assistant for a codebase-recon system.

You cannot read files, run tools, browse the repository, or ask a follow-up question — this prompt is the ONLY thing
you will ever see. Only cite a { file, line } pair that appears in a cluster's own "samples" below, or leave it in
"gaps". Never invent a file path, a line number, or a symbol that isn't shown to you verbatim.

Consolidate the CANDIDATE TECHNICAL CLUSTERS below (deterministic directory/namespace groupings extracted from the
code — structure, not business meaning) into coherent BUSINESS features, and derive a SEPARATED identity model:
actors (principals), roles (privilege levels), permissions (resource+operation grants).

Rules:
- A feature is a coherent business capability, NOT a file, class, directory, test, migration, serializer or GraphQL
  type. A cluster named "admin", "issues" or "payments" is NOT automatically a feature on its own — only real,
  evidence-proven capabilities are. Merge related clusters into one feature when they implement the same capability.
- Keep shared infrastructure outside feature names.
- include_paths and include_terms must be distinctive selectors grounded in paths/names shown to you.
- IDENTITY IS SEPARATED: actors are independent security principals that can authenticate, possess credentials, or be
  the subject of an authorization decision; roles are privilege levels assigned to those principals; permissions are
  resource operations granted to actors/roles. Internal classes, worker processes, validators, middleware and
  infrastructure are architecture, NOT actors merely because they do work. A guard, validation rule, rate limit,
  origin check or safety invariant is a CONTROL, NOT a permission. Do not place controls in actors/roles/permissions.
- Derive roles ONLY from evidence that reads like authoritative production or config source (a role/access-level
  enum, a membership model, an explicit grant) — never from a sample whose file path is a test/spec/fixture/doc/asset.
  Every permission must name its resource and operation and identify at least one grounded grantee in
  enabled_by_roles or granted_to_actors. NEVER classify a permission name, method name, or arbitrary string as a role.
- For each actor, classify kind as human, token, service, system, or integration. For each feature, list the
  grounded permission names that govern it. Preserve operation/resource granularity; never collapse permissions into
  a vague "access" grant.
- EVERY feature, actor, role and permission MUST cite grounded evidence: { file, line, symbol, reason } copied from
  a sample shown to you below. Anything you cannot ground this way belongs in "gaps", never invented.
- Cover the clusters below without overlapping selectors where practical. Prefer durable capabilities over
  implementation nouns.
- Recon only: do not report vulnerabilities or security findings.

${RESPONSE_SHAPE}

CANDIDATE CLUSTERS (${summarizedClusters.length}):
${JSON.stringify(summarizedClusters)}`;
}

// Strip a ```json fenced block if present; a model asked for "only JSON" sometimes wraps it anyway.
function stripCodeFences(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1] : s;
}

// Find the first balanced {...} block, respecting string literals so a brace inside a quoted value never
// mis-terminates the object early.
function firstBalancedObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Defensive parse: strip fences, take the first balanced object, JSON.parse. Any failure (or a shape that isn't
// even an object) returns null — never throws. Missing arrays default to [] rather than rejecting the whole chunk,
// since a partial-but-real plan (e.g. features only, no actors yet) is still useful input to validateOntology.
function parsePlanResponse(text) {
  try {
    const objText = firstBalancedObject(stripCodeFences(text)) || firstBalancedObject(text);
    if (!objText) return null;
    const parsed = JSON.parse(objText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const hasAnyArray = ['features', 'actors', 'roles', 'permissions'].some((k) => Array.isArray(parsed[k]));
    if (!hasAnyArray) return null;
    return {
      features: Array.isArray(parsed.features) ? parsed.features : [],
      actors: Array.isArray(parsed.actors) ? parsed.actors : [],
      roles: Array.isArray(parsed.roles) ? parsed.roles : [],
      permissions: Array.isArray(parsed.permissions) ? parsed.permissions : [],
      relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    };
  } catch { return null; }
}

// Group by domain:top-two-path-segments and byte-budget-pack, ported from codengram's createReconWorkstreams
// (claude-runtime/index.js:208-249), trimmed to just the grouping/packing this module needs (no session/id
// bookkeeping — each ask() call below is already stateless).
function chunkClusters(summarizedClusters, { maxBytes, maxClusters = 60 } = {}) {
  const groups = new Map();
  for (const cluster of summarizedClusters || []) {
    const firstPath = String(cluster.paths?.[0] || '');
    const locality = firstPath.split('/').filter(Boolean).slice(0, 2).join('/') || 'root';
    const key = `${cluster.domain || 'core'}:${locality}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cluster);
  }
  const localityChunks = [];
  for (const [locality, clusters] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let batch = [], bytes = 2;
    const flush = () => {
      if (!batch.length) return;
      localityChunks.push({ locality, domain: locality.split(':')[0], clusters: batch, summary_bytes: bytes });
      batch = []; bytes = 2;
    };
    for (const cluster of clusters.sort((a, b) => String(a.slug).localeCompare(String(b.slug)))) {
      const size = jsonBytes(cluster) + 1;
      if (batch.length && (bytes + size > maxBytes || batch.length >= maxClusters)) flush();
      batch.push(cluster); bytes += size;
    }
    flush();
  }
  const bins = [];
  for (const chunk of localityChunks.sort((a, b) => b.summary_bytes - a.summary_bytes)) {
    let bin = bins.find((candidate) => candidate.domain === chunk.domain && candidate.summary_bytes + chunk.summary_bytes <= maxBytes);
    if (!bin) { bin = { domain: chunk.domain, clusters: [], summary_bytes: 2 }; bins.push(bin); }
    bin.clusters.push(...chunk.clusters);
    bin.summary_bytes += chunk.summary_bytes;
  }
  return bins;
}

function mergeNamed(items, keyFn, arrayFields = []) {
  const merged = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key) continue;
    if (!merged.has(key)) { merged.set(key, { ...item }); continue; }
    const current = merged.get(key);
    for (const field of arrayFields) {
      current[field] = field === 'evidence'
        ? uniqObjects([...(current[field] || []), ...(item[field] || [])])
        : uniq([...(current[field] || []), ...(item[field] || [])]);
    }
    for (const [field, value] of Object.entries(item)) if ((current[field] == null || current[field] === '') && value != null) current[field] = value;
  }
  return [...merged.values()];
}

// Merge parsed per-chunk plans by stable semantic identity, retaining every selector/citation. Ported from
// codengram's mergeReconPlans (claude-runtime/index.js:268-279) — evidence-validator remains the final authority
// over what actually survives into the graph.
export function mergeReconPlans(plans = [], extraGaps = []) {
  const all = (plans || []).filter(Boolean);
  return {
    features: mergeNamed(all.flatMap((p) => p.features || []),
      (f) => `${String(f.domain || 'core').toLowerCase()}/${String(f.slug || f.name || '').toLowerCase()}`,
      ['include_paths', 'include_terms', 'include_symbols', 'include_entries', 'inventory_keys', 'exclude_paths', 'exclude_terms', 'actors', 'permissions', 'evidence']),
    actors: mergeNamed(all.flatMap((p) => p.actors || []), (a) => String(a.name || '').toLowerCase(), ['scopes', 'evidence']),
    roles: mergeNamed(all.flatMap((p) => p.roles || []), (r) => String(r.name || '').toLowerCase(), ['enables', 'evidence']),
    permissions: mergeNamed(all.flatMap((p) => p.permissions || []), (p) => String(p.name || '').toLowerCase(), ['enabled_by_roles', 'granted_to_actors', 'evidence']),
    relationships: uniqObjects(all.flatMap((p) => p.relationships || [])),
    gaps: uniq([...all.flatMap((p) => p.gaps || []), ...extraGaps]),
  };
}

async function runSingleShot(summarizedClusters, adapter, { model, effort } = {}) {
  let text;
  try { text = await adapter.ask(buildPrompt(summarizedClusters), { model, effort }); }
  catch { return null; }
  return parsePlanResponse(text);
}

// planClusters(clusters, adapter, opts) → raw plan object, or null.
// `clusters` is the deterministic cluster list (semantic-planner.js's deterministicSemanticPlan shape).
// `adapter` is injected — anything shaped like { ask(prompt, { model, effort }) => Promise<string> } (SecForge's
// @secforge/adapters makeAdapter(...).ask, or a fake in tests). Never constructed here.
// Fails closed: returns null when there is nothing to plan, the adapter is missing/malformed, or every ask()
// response (single-shot or every chunk) fails to parse. Never throws.
export async function planClusters(clusters, adapter, { model, effort, maxBytes = 180_000 } = {}) {
  if (!adapter || typeof adapter.ask !== 'function') return null;
  const summarized = summarizeClusters(clusters);
  if (!summarized.length) return null;

  if (jsonBytes(summarized) <= maxBytes) {
    return await runSingleShot(summarized, adapter, { model, effort });
  }

  const bins = chunkClusters(summarized, { maxBytes });
  const results = await Promise.all(bins.map((bin) => runSingleShot(bin.clusters, adapter, { model, effort })));
  const parsed = results.filter(Boolean);
  if (!parsed.length) return null;
  const failedCount = bins.length - parsed.length;
  const gaps = failedCount > 0 ? [`${failedCount} semantic chunk(s) failed to parse and were dropped`] : [];
  return mergeReconPlans(parsed, gaps);
}
