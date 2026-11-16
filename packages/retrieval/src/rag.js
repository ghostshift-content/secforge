// @secforge/retrieval/rag — the small retrieval store the map writes per snapshot so a later
// "test X" knows WHERE TO LOOK. One chunk per feature / entry point / job / service / data store /
// role / permission / actor / auth check, each carrying file:line pointers and the feature it belongs
// to. Pure projection of the graph (no LLM, no live source), zero deps: BM25 over a light stemmer.
// Written to `snapshots/<sid>/rag/{chunks.jsonl,index.json}`; locate() reads it (or rebuilds from
// the graph in memory when a snapshot predates this file).
import fs from 'node:fs';
import path from 'node:path';
import { readGraph, currentSnapshotId } from '@secforge/store';

export const RAG_VERSION = '1';

// ---- tokenizer -------------------------------------------------------------------------------
// Words of asking ("test the X", "check whether", "find any") carry no location signal; drop them.
const STOP = new Set(('the a an and or of to in on for is are be by with as at from that this it its any all some ' +
  'test tests testing check checks find look looks where does do can could should whether if what which how into ' +
  'without with via when about').split(' '));
// ponytail: naive suffix stemmer (approval/approve/approving → approv) — swap for Porter if recall misses.
function stem(t) {
  if (t.length <= 3) return t;
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('ation') && t.length > 7) t = t.slice(0, -5);
  else if (t.endsWith('ing') && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith('ed') && t.length > 4) t = t.slice(0, -2);
  else if (t.endsWith('al') && t.length > 5) t = t.slice(0, -2);
  else if (t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (/([a-z])\1$/.test(t)) t = t.slice(0, -1); // submitt → submit
  if (t.endsWith('e') && t.length > 4) t = t.slice(0, -1); // approve → approv, expense → expens
  return t;
}
export function tokenize(s) {
  return String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

// ---- chunks ----------------------------------------------------------------------------------
const fileLine = (n) => { const f = n.data?.file || n.claims?.[0]?.file; return f ? `${f}:${n.data?.line || n.claims?.[0]?.line || 0}` : null; };
const KIND = { ENDPOINT: 'endpoint', ROUTE: 'endpoint', GRAPHQL_OPERATION: 'endpoint', JOB: 'job', SERVICE: 'service',
  MODEL: 'data', DATA_STORE: 'data', ROLE: 'role', PERMISSION: 'permission', ACTOR: 'actor', AUTH_CHECK: 'auth' };
const ifaceOf = (n) => n.type === 'GRAPHQL_OPERATION' || n.data?.interface_kind === 'graphql' ? 'graphql'
  : n.type === 'JOB' ? 'job' : n.data?.interface_kind === 'rest' ? 'rest' : 'web';
const names = (arr) => arr.map((n) => n.name || n.id);
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/** Graph → chunks. Pure; the same function the map persists and locate() falls back to. */
export function buildChunks(graph) {
  const nodes = graph?.nodes || [], edges = graph?.edges || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map(), inn = new Map();
  for (const e of edges) {
    if (!out.has(e.src)) out.set(e.src, []); out.get(e.src).push(e);
    if (!inn.has(e.dst)) inn.set(e.dst, []); inn.get(e.dst).push(e);
  }
  const tgt = (id, ...types) => (out.get(id) || []).filter((e) => types.includes(e.type)).map((e) => byId.get(e.dst)).filter(Boolean);
  const featureOf = (id) => (inn.get(id) || []).map((e) => byId.get(e.src)).find((n) => n?.type === 'FEATURE') || null;

  // A bare ROUTE whose handler file:line is already an ENDPOINT is the same handler seen twice: one
  // chunk, but the ROUTE's words ("action download_receipt") ride along — they are the tester's words.
  const endpointKeys = new Set(nodes.filter((n) => n.type === 'ENDPOINT').map(fileLine).filter(Boolean));
  const folded = new Map();
  for (const n of nodes) if (n.type === 'ROUTE' && endpointKeys.has(fileLine(n))) folded.set(fileLine(n), `${folded.get(fileLine(n)) || ''} ${n.name || ''} ${n.data?.path || ''}`.trim());
  const chunks = [];
  for (const n of nodes) {
    const kind = n.type === 'FEATURE' ? 'feature' : KIND[n.type];
    if (!kind) continue;
    if (n.type === 'ROUTE' && endpointKeys.has(fileLine(n))) continue;
    const feature = kind === 'feature' ? n : featureOf(n.id);
    const d = n.data || {};
    const where = { files: uniq([fileLine(n)]), nodes: [n.id] };
    const parts = [n.name, d.purpose, d.description, d.domain, d.resource, d.operation, d.obtained_via, d.scope, ...(d.scopes || [])];
    let meta = null;
    if (kind === 'endpoint' || kind === 'job') {
      const authn = tgt(n.id, 'AUTHENTICATED_BY'), authz = tgt(n.id, 'AUTHORIZED_BY', 'GUARDED_BY'), roles = tgt(n.id, 'REQUIRES_ROLE');
      const http = kind === 'endpoint'; // a background job has no caller to authenticate — authn/authz are not a gap there
      meta = { method: d.method || null, route: d.route || d.path || null, interface: ifaceOf(n), authn: http ? authn.length > 0 : null, authz: http ? authz.length > 0 : null,
        roles: names(roles), guards: names([...authn, ...authz]) };
      where.files.push(...[...authn, ...authz].map(fileLine)); where.nodes.push(...[...authn, ...authz, ...roles].map((x) => x.id));
      parts.push(meta.method, meta.route, meta.interface, d.file, folded.get(fileLine(n)), ...meta.guards, ...meta.roles);
      if (http) parts.push(meta.authn ? 'authenticated login required' : 'unauthenticated anonymous public no login', meta.authz ? 'authorized' : 'no authorization check');
    } else if (kind === 'feature') {
      // Its members' names ride along so "receipt" finds the feature even when only one route says it.
      const members = tgt(n.id, 'EXPOSES', 'HANDLED_BY', 'USES_SERVICE', 'AUTHORIZED_BY', 'AUTHENTICATED_BY', 'CONTAINS');
      parts.push(...members.map((m) => [m.name, m.data?.route, m.data?.path, m.data?.description].filter(Boolean).join(' ')));
      where.nodes.push(...members.map((m) => m.id));
    } else if (kind === 'permission' || kind === 'role') {
      parts.push(...names(tgt(n.id, 'REQUIRES_ROLE', 'HAS_ROLE', 'GRANTS', 'AUTHORIZED_BY')));
    }
    if (feature && feature.id !== n.id) parts.push(feature.name);
    where.files = uniq(where.files); where.nodes = uniq(where.nodes);
    chunks.push({ id: `chunk:${n.id}`, node: n.id, kind, feature: feature?.id || null, featureName: feature?.name || null,
      title: meta?.route ? `${meta.method || ''} ${meta.route}`.trim() : (n.name || n.id), text: parts.filter(Boolean).join(' · '), where, meta });
  }
  return chunks;
}

/** Persist the store beside the snapshot's phase1-maps. Returns { root, files }. */
export function writeRagIndex(snapshotDir, graph, { snapshotId = null } = {}) {
  const chunks = buildChunks(graph);
  const root = path.join(snapshotDir, 'rag');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + (chunks.length ? '\n' : ''));
  const counts = {};
  for (const c of chunks) counts[c.kind] = (counts[c.kind] || 0) + 1;
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ version: RAG_VERSION, snapshotId, builtAt: new Date().toISOString(),
    chunks: chunks.length, counts, usage: 'GET /api/projects/:id/locate?q=<what to test> — or grep chunks.jsonl; each row carries where.files (file:line) and feature' }, null, 2));
  return { root, files: 2, chunks: chunks.length };
}

async function loadChunks(store, projectId, sid) {
  try {
    const text = fs.readFileSync(path.join(store.projectDir(projectId), 'snapshots', sid, 'rag', 'chunks.jsonl'), 'utf8');
    return { chunks: text.split('\n').filter(Boolean).map((l) => JSON.parse(l)), source: 'rag' };
  } catch {
    return { chunks: buildChunks(await readGraph(store, projectId, sid)), source: 'graph' };
  }
}

// ---- BM25 ------------------------------------------------------------------------------------
export function rankChunks(chunks, query, { k1 = 1.2, b = 0.75 } = {}) {
  const terms = uniq(tokenize(query));
  if (!terms.length || !chunks.length) return { terms, hits: [] };
  const docs = chunks.map((c) => tokenize(`${c.title} ${c.text}`));
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const hits = [];
  chunks.forEach((c, i) => {
    const d = docs[i];
    let score = 0;
    const matched = [];
    for (const t of terms) {
      const tf = d.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.length / avgdl));
      matched.push(t);
    }
    if (score > 0) hits.push({ ...c, score: Math.round(score * 1000) / 1000, matched });
  });
  return { terms, hits: hits.sort((a, b2) => b2.score - a.score) };
}

/**
 * "Where does X live?" — rank the snapshot's chunks for a free-text ask and roll them up into the
 * features, entry points and files a tester (or the Assess engine) should look at first.
 * coverageGap:true when nothing matches — never a guess.
 */
export async function locate(store, projectId, query, { snapshotId, limit = 8 } = {}) {
  const sid = snapshotId || (await currentSnapshotId(store, projectId));
  const { chunks, source } = await loadChunks(store, projectId, sid);
  const { terms, hits } = rankChunks(chunks, query);
  const features = new Map(), files = new Map();
  for (const h of hits) {
    const fid = h.kind === 'feature' ? h.node : h.feature;
    if (fid) {
      const f = features.get(fid) || { id: fid, name: h.kind === 'feature' ? h.title : h.featureName, score: 0, hits: [] };
      f.score = Math.round((f.score + h.score) * 1000) / 1000;
      if (h.kind !== 'feature' && f.hits.length < 6) f.hits.push(h.title);
      features.set(fid, f);
    }
    // The chunk's own handler line is where to look; a shared guard (one authenticate_user! every
    // endpoint points at) would otherwise outscore every handler, so it only earns a quarter.
    h.where.files.forEach((fl, i) => files.set(fl, Math.round(((files.get(fl) || 0) + h.score * (i === 0 ? 1 : 0.25)) * 1000) / 1000));
  }
  const top = (m) => [...m.values()].sort((a, b) => b.score - a.score);
  return {
    ok: hits.length > 0, coverageGap: hits.length === 0, query: String(query || ''), terms, source, snapshotId: sid || null,
    features: top(features).slice(0, limit),
    endpoints: hits.filter((h) => h.kind === 'endpoint' || h.kind === 'job').slice(0, limit * 2)
      .map((h) => ({ id: h.node, title: h.title, feature: h.feature, featureName: h.featureName, score: h.score, ...h.meta, files: h.where.files })),
    files: [...files.entries()].map(([file, score]) => ({ file, score })).sort((a, b) => b.score - a.score).slice(0, limit * 2),
    chunks: hits.slice(0, limit * 3).map((h) => ({ id: h.id, kind: h.kind, title: h.title, feature: h.feature, score: h.score, matched: h.matched, where: h.where })),
  };
}
