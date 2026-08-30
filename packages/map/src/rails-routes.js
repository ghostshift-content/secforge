// @secforge/map/rails-routes — Rails conventional-route synthesis (mapper-design.md, "Rails
// conventional-route synthesis"). `resources :x` in config/routes.rb + `def action` in a
// controller produce NO method+route today (the plugin only expands `resources :x` into a bare
// `{entry:'resources :x'}` marker row, so @secforge/recon/graph.js falls back to a ROUTE node,
// never an ENDPOINT the rule engine can score). This walks routes.rb's block structure itself
// and synthesizes the standard REST actions (+ member/collection blocks + nested resources),
// correlating each synthesized action to its controller action's row.body (from
// @secforge/inventories' railsControllerActions) so §7's body-scoped auth attribution never lets
// a guarded sibling action mask an unguarded one. Deterministic, stdlib-only, best-effort: an
// unparseable routes.rb yields fewer synthesized rows, never a thrown error.
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_FILE_RE = /(^|\/)config\/routes(?:\.\w+)?\.rb$/;
const BLOCK_OPEN_RE = /\bdo\b\s*(?:\|[^|]*\|)?\s*$/;

// Minimal, good-enough singularizer for the `<parent>_id` nested-resource param name.
const singularize = (s) => {
  const v = String(s || '');
  if (/(?:status|news|analysis|basis|series|species)$/i.test(v)) return v;
  if (v.length > 4 && /ies$/i.test(v)) return v.slice(0, -3) + 'y';
  if (v.length > 4 && /(?:ches|shes|xes|zes)$/i.test(v)) return v.slice(0, -2);
  return v.length > 3 && /s$/i.test(v) && !/(?:ss|us|is)$/i.test(v) ? v.slice(0, -1) : v;
};

// Rails' own default order for `resources :x`.
const STANDARD_ACTIONS = [
  ['index', 'GET', ''], ['create', 'POST', ''],
  ['new', 'GET', '/new'], ['edit', 'GET', '/:id/edit'],
  ['show', 'GET', '/:id'], ['update', 'PATCH', '/:id'], ['destroy', 'DELETE', '/:id'],
];

function parseOnlyExcept(rest) {
  const grab = (kw) => {
    const brackets = rest.match(new RegExp(`${kw}:\\s*\\[([^\\]]*)\\]`));
    if (brackets) return [...brackets[1].matchAll(/:(\w+)/g)].map((m) => m[1]);
    const single = rest.match(new RegExp(`${kw}:\\s*:(\\w+)\\b`));
    return single ? [single[1]] : null;
  };
  return { only: grab('only'), except: grab('except') };
}

const stripComment = (line) => line.replace(/#.*$/, '');
// The path prefix a NEW child frame is nested under: a resources frame contributes its ITEM path
// (`/x/:x_id`) to children (member/collection/nested resources all act on one parent record);
// anything else (namespace/other) contributes its own plain path unchanged.
const parentBase = (stack) => {
  if (!stack.length) return '';
  const top = stack[stack.length - 1];
  return top.type === 'resources' ? top.childBase : top.path;
};

// Parse one routes.rb file's text into synthesized { line, method, path, namespaceSegs, resource,
// action } entries. A tiny stack machine over Ruby's `do`/`end` block nesting — namespace/
// resources/member/collection are understood specifically; any other block (scope, constraints,
// concern…) is pushed as an opaque pass-through frame so nesting depth stays correct.
function parseRailsRoutes(text) {
  const lines = text.split(/\r?\n/);
  const stack = [];
  const out = [];

  const emitStandard = (line, name, only, except, namespaceSegs, base) => {
    for (const [action, method, suffix] of STANDARD_ACTIONS) {
      if (only && !only.includes(action)) continue;
      if (except && except.includes(action)) continue;
      out.push({ line, method, path: `${base}${suffix}`, namespaceSegs: [...namespaceSegs], resource: name, action });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = stripComment(lines[i]);
    const t = raw.trim();
    if (!t) continue;
    if (/^end\b/.test(t)) { stack.pop(); continue; }

    const ns = t.match(/^namespace\s+:(\w+)\b/);
    if (ns) {
      if (BLOCK_OPEN_RE.test(raw)) stack.push({ type: 'namespace', seg: ns[1], path: `${parentBase(stack)}/${ns[1]}` });
      continue;
    }

    const res = t.match(/^resources\s+:(\w+)\b(.*)$/);
    if (res) {
      const [, name, rest] = res;
      const { only, except } = parseOnlyExcept(rest);
      const namespaceSegs = stack.filter((f) => f.type === 'namespace').map((f) => f.seg);
      const base = `${parentBase(stack)}/${name}`;
      emitStandard(i + 1, name, only, except, namespaceSegs, base);
      if (BLOCK_OPEN_RE.test(raw)) {
        stack.push({ type: 'resources', name, path: base, itemPath: `${base}/:id`, childBase: `${base}/:${singularize(name)}_id`, namespaceSegs });
      }
      continue;
    }

    const isMember = /^member\b/.test(t), isCollection = /^collection\b/.test(t);
    if ((isMember || isCollection) && BLOCK_OPEN_RE.test(raw)) {
      const owner = [...stack].reverse().find((f) => f.type === 'resources');
      stack.push({
        type: isMember ? 'member' : 'collection',
        path: owner ? (isMember ? owner.itemPath : owner.path) : parentBase(stack),
        namespaceSegs: owner ? owner.namespaceSegs : [],
        resource: owner ? owner.name : null,
      });
      continue;
    }

    const top = stack[stack.length - 1];
    if (top && (top.type === 'member' || top.type === 'collection')) {
      const v = t.match(/^(get|post|put|patch|delete)\s+:(\w+)/i);
      if (v) out.push({ line: i + 1, method: v[1].toUpperCase(), path: `${top.path}/${v[2]}`, namespaceSegs: [...top.namespaceSegs], resource: top.resource, action: v[2] });
      continue;
    }

    if (BLOCK_OPEN_RE.test(raw)) stack.push({ type: 'other', path: parentBase(stack), namespaceSegs: stack.filter((f) => f.type === 'namespace').map((f) => f.seg) });
  }
  return out;
}

/**
 * Synthesize resolved `{method,path}` rows for every `resources`/member/collection route in
 * every config/routes.rb in the manifest, correlated to the owning controller action's row (and
 * its body span, if Package A bounded one) so per-action auth attribution stays precise.
 * @param {{manifest: Array<{path:string}>, sourceRoot: string, inventories: object}} args
 * @returns {Array<object>} rows to merge into inventories.routes_endpoints
 */
export function synthesizeRailsRoutes({ manifest, sourceRoot, inventories }) {
  const routesFiles = (manifest || []).map((m) => m.path).filter((p) => ROUTES_FILE_RE.test(p));
  if (!routesFiles.length) return [];

  const controllerActions = (inventories.routes_endpoints || []).filter((r) => r.detail === 'controller-action');
  const findAction = (fileSuffix, action) => controllerActions.find((r) => r.file.endsWith(fileSuffix) && r.entry === `action ${action}`);

  const rows = [];
  for (const relPath of routesFiles) {
    let text;
    try { text = fs.readFileSync(path.join(sourceRoot, relPath), 'utf8'); } catch { continue; }
    let parsed = [];
    try { parsed = parseRailsRoutes(text); } catch { /* malformed routes.rb — best-effort, skip */ }
    for (const r of parsed) {
      const suffix = `${[...r.namespaceSegs, r.resource].join('/')}_controller.rb`;
      const ctrlRow = findAction(suffix, r.action);
      const row = ctrlRow
        ? { file: ctrlRow.file, line: ctrlRow.line, entry: `${r.method} '${r.path}'`, method: r.method, path: r.path, detail: 'rails-synth' }
        : { file: relPath, line: r.line, entry: `${r.method} '${r.path}'`, method: r.method, path: r.path, detail: 'rails-synth' };
      if (ctrlRow && ctrlRow.body) row.body = ctrlRow.body;
      rows.push(row);
    }
  }
  return rows;
}
