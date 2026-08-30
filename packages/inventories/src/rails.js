// @secforge/inventories/rails — the Rails plugin. Ported from codengram's packages/inventories/index.js
// (railsRestApi/railsRouteInventories/railsPlugin), plus a body-span extension (design §7, required): every
// routes_endpoints/rest_api row whose owning `def action ... end` / grape verb block can be bounded carries
// `row.body = {startLine, endLine}`, so Package B can scope auth attribution to the exact action instead of the
// whole controller file (a per-action IDOR must not be masked by a guarded sibling action in the same file).
import { definePlugin, INVENTORY_KEYS } from './plugins.js';
import { item } from './universal.js';

const rubyApiClass = (text) => text.match(/^\s*class\s+([\w:]+)\s*<\s*(?:::)?(?:API::Base|Grape::API)\b/)?.[1] || '';
const rubyScope = (text) => text.match(/^\s*(?:namespace|resource|resources|segment|prefix)\s+(?::|['"])([\w/:.-]+)/)?.[1] || '';
const rubyVerb = (text) => text.match(/^\s*(get|post|put|patch|delete)\b(?:\s+(?:['"]([^'"]*)['"]|(?!do\b)([a-zA-Z_]\w*)))?/i);
const rubyBlockStart = (text) => /\bdo\b\s*(?:\|[^|]*\|)?\s*$/.test(text) ||
  /^\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b/.test(text);
const rubyBlockDelta = (text) => (text.match(/\bdo\b/g) || []).length +
  (/^\s*(?:class|module|def|if|unless|case|begin|while|until|for)\b/.test(text) ? 1 : 0) -
  (text.match(/\bend\b/g) || []).length;

// Body-span extension: bound a ruby block (a `def`/`do` opener at `start`) by cumulative block-depth. Returns
// null when the block can't be bounded (e.g. malformed source, or the opener never closes in this file).
function rubyBlockSpan(lines, start) {
  let depth = rubyBlockDelta(lines[start]);
  if (depth <= 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    depth += rubyBlockDelta(lines[i]);
    if (depth <= 0) return { startLine: start + 1, endLine: i + 1 };
  }
  return null;
}
function rubyEndpointBody(lines, start) {
  const span = rubyBlockSpan(lines, start);
  return span ? lines.slice(start + 1, span.endLine - 1).join('\n') : '';
}

// GitLab-style Grape/API::Base endpoints, including pathless verbs inside nested resource blocks.
function railsRestApi(ctx) {
  const rows = [];
  for (const file of ctx.files.filter((f) => f.ext === '.rb')) {
    const lines = ctx.read(file.path).split(/\r?\n/);
    if (!lines.some((line) => rubyApiClass(line)) && !/(^|\/)(?:ee\/)?lib\/api\//.test(file.path)) continue;
    const blocks = [];
    let apiClass = '', pendingPurpose = '', pendingAuth = '';
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], text = raw.trim();
      if (/^end\b/.test(text)) { blocks.pop(); continue; }
      apiClass = rubyApiClass(raw) || apiClass;
      const desc = text.match(/^desc\s+['"]([^'"]+)/)?.[1];
      if (desc) pendingPurpose = desc;
      if (/^(?:route_setting\s+:authorization|authenticate!|authenticated_as_admin!|authorize!)/.test(text)) pendingAuth = text;

      const scope = rubyScope(raw);
      const verb = rubyVerb(raw);
      if (verb) {
        const method = verb[1].toUpperCase();
        const prefix = blocks.map((b) => b.scope).filter(Boolean);
        const variable = verb[3];
        const bound = variable ? [...blocks].reverse().find((b) => b.bindings?.[variable])?.bindings[variable] : null;
        const ownPaths = verb[2] != null ? [verb[2]] : bound || (variable ? [] : ['']);
        const body = rubyEndpointBody(lines, i);
        const bodySpan = rubyBlockSpan(lines, i);
        const authHits = [...body.matchAll(/\b(authenticate!|authenticated_as_admin!|authorize!\s*[^\n;]*|can\?\s*[^\n;]*|allowed\?\s*[^\n;]*)/g)]
          .slice(0, 3).map((m) => m[0].trim());
        for (const ownPath of ownPaths) {
          const own = String(ownPath || '').replace(/^\//, '');
          const endpoint = `/${[...prefix, own].filter(Boolean).join('/')}`.replace(/\/{2,}/g, '/');
          const row = { file: file.path, line: i + 1, entry: `${method} '${endpoint || '/'}'`, detail: 'grape',
            method, path: endpoint || '/', api_class: apiClass ? `API::${apiClass.replace(/^API::/, '')}` : 'API',
            purpose: pendingPurpose || 'REST API operation', auth_notes: [...new Set([pendingAuth, ...authHits].filter(Boolean))].join('; ') };
          if (bodySpan) row.body = bodySpan;
          rows.push(row);
        }
        pendingPurpose = ''; pendingAuth = '';
      }

      if (rubyBlockStart(raw)) {
        const each = raw.match(/\[([^\]]+)\]\.each\s+do\s+\|(\w+)\|/);
        const values = each ? [...each[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];
        blocks.push({ scope: scope || '', bindings: each && values.length ? { [each[2]]: values } : null });
      }
    }
  }
  return rows;
}

// `resources :a, :b` EXPANDED into one row per resource; verb routes with a literal path.
function railsRouteInventories(ctx) {
  const routes = [], rest = [];
  for (const file of ctx.files.filter((f) => /(^|\/)config\/routes(?:\.\w+)?\.rb$/.test(f.path))) {
    const lines = ctx.read(file.path).split(/\r?\n/), blocks = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i], text = raw.trim(), hit = { file: file.path, line: i + 1 };
      if (/^end\b/.test(text)) { blocks.pop(); continue; }
      const scope = text.match(/^namespace\s+(?::|['"])([\w-]+)/)?.[1] || rubyScope(raw);
      const prefix = blocks.map((b) => b.scope).filter(Boolean);
      const apiScoped = prefix.includes('api') || prefix.includes('api/v1') || prefix.includes('api/v2');
      const resGroup = text.match(/\bresources?\s+((?::\w+\s*,?\s*)+)/);
      if (resGroup) for (const symbol of resGroup[1].match(/:\w+/g) || []) {
        routes.push(item(hit, `resources ${symbol}`, 'route'));
        if (apiScoped) {
          const resource = symbol.slice(1), routePath = `/${[...prefix, resource].join('/')}`.replace(/\/{2,}/g, '/');
          rest.push({ file: file.path, line: i + 1, entry: `resources ${symbol}`, detail: 'rails-api-route',
            method: 'RESOURCE', path: routePath, api_class: 'Rails API routes', purpose: 'REST API resource', auth_notes: '' });
        }
      }
      const verb = text.match(/\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]/i);
      if (verb) {
        const method = verb[1].toUpperCase(), literal = verb[2], routePath = literal.startsWith('/') ? literal : `/${[...prefix, literal].filter(Boolean).join('/')}`;
        routes.push(item(hit, `${verb[1]} '${literal}'`, 'route'));
        if (apiScoped || /^\/api(?:\/|$)/.test(routePath)) rest.push({ file: file.path, line: i + 1,
          entry: `${method} '${routePath}'`, detail: 'rails-api-route', method, path: routePath,
          api_class: 'Rails API routes', purpose: 'REST API operation', auth_notes: '' });
      }
      if (rubyBlockStart(raw)) blocks.push({ scope: scope || '' });
    }
  }
  return { routes, rest };
}

// Controller `def action`s, each carrying a body span so per-action auth attribution never inherits a sibling
// action's guard.
function railsControllerActions(ctx) {
  const rows = [];
  for (const file of ctx.files.filter((f) => f.ext === '.rb' && /(^|\/)app\/controllers\//.test(f.path) && /_controller\.rb$/.test(f.name))) {
    const lines = ctx.read(file.path).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*def\s+([a-zA-Z_][\w!?=]*)/);
      if (!m) continue;
      const isHelper = /_params$|^(set|find|load|ensure|validate|authorize)_/.test(m[1]);
      const row = item({ file: file.path, line: i + 1 }, `${isHelper ? 'helper' : 'action'} ${m[1]}`, isHelper ? 'controller-helper' : 'controller-action');
      const span = rubyBlockSpan(lines, i);
      if (span) row.body = span;
      rows.push(row);
    }
  }
  return rows;
}

// Controller's own `class X < Y` declaration (first match — a controller has exactly one).
function controllerClassInfo(lines) {
  for (const raw of lines) {
    const m = raw.match(/^\s*class\s+([\w:]+)\s*<\s*([\w:]+)/);
    if (m) return { className: m[1], parentClass: m[2] };
  }
  return { className: '', parentClass: '' };
}

// Rails refinement 1 (mapper-design.md §7): `before_action`/`skip_before_action` are class-body
// macros — AUTHENTICATION is a controller-FILE (or ancestor controller) property, never scoped to
// one action's body. Surface every `before_action ...authenticate...` / `skip_before_action
// ...authenticate...` line at controller-file granularity, tagged with the controller's own
// class/parent name so @secforge/recon/graph.js can resolve inheritance (e.g. ApplicationController)
// to compute a project-wide authenticated-by-default baseline. AUTHORIZATION stays body-scoped —
// unaffected, still comes from the generic `authorize`/`can?` grep below.
function railsControllerAuthRows(ctx) {
  const rows = [];
  for (const file of ctx.files.filter((f) => f.ext === '.rb' && /_controller\.rb$/.test(f.name))) {
    const lines = ctx.read(file.path).split(/\r?\n/);
    const { className, parentClass } = controllerClassInfo(lines);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].trim();
      const isSkip = /^skip_before_action\b/.test(text);
      if (!isSkip && !/^before_action\b/.test(text)) continue;
      if (!/authenticate/i.test(text)) continue;
      rows.push({ file: file.path, line: i + 1, entry: text, detail: isSkip ? 'skip-authn' : 'authn',
        controllerClass: className, controllerParent: parentClass });
    }
  }
  return rows;
}

export const railsPlugin = definePlugin({
  id: 'rails', langs: ['Ruby'],
  // A repo can be Rails-shaped without a Gemfile at its root (subtrees, extracted apps, fixtures).
  detect: (profile) => {
    if ((profile?.frameworks || []).includes('Rails') || (profile?.manifests || []).includes('Gemfile')) return true;
    const hasRuby = (profile?.languages_by_bytes || []).some((l) => l.ext === '.rb');
    const railsLayout = (profile?.entry_points || []).some((e) => /(^|\/)config\/routes\.rb$/.test(e)) ||
      (profile?.top_directories || []).some((d) => d.dir === 'app');
    return hasRuby && railsLayout;
  },
  inventory(ctx) {
    const g = ctx.grep.bind(ctx);
    const out = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]));

    const routeInventories = railsRouteInventories(ctx);
    out.routes_endpoints = [...routeInventories.routes, ...railsControllerActions(ctx)];
    out.rest_api = [...routeInventories.rest, ...railsRestApi(ctx)];
    out.graphql = g(/^\s*field\s+:\w+/, { pathRe: /(^|\/)app\/graphql\//, nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'graphql-field'))
      .concat(g(/class\s+\w+\s*<\s*(Types::|Resolvers::|Mutations::)/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'graphql-type')));
    out.workers_jobs = g(/include\s+Sidekiq::(Worker|Job)|<\s*ApplicationJob\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'worker'))
      .concat(g(/\.(perform_async|perform_later|perform_in|set\()/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'enqueue')));
    out.services_finders_policies = ctx.files
      .filter((f) => /(^|\/)app\/(services|finders|policies)\//.test(f.path) && f.ext === '.rb')
      .map((f) => ({ file: f.path, line: 1, entry: f.path.split('/').pop(), detail: f.path.includes('/policies/') ? 'policy' : f.path.includes('/finders/') ? 'finder' : 'service' }))
      .concat(ctx.files.filter((f) => /(^|\/)app\/models\//.test(f.path) && f.ext === '.rb')
        .map((f) => ({ file: f.path, line: 1, entry: f.path.split('/').pop(), detail: 'model' })));
    out.response_shaping = ctx.files.filter((f) => /(^|\/)app\/(serializers|presenters)\//.test(f.path) && f.ext === '.rb')
      .map((f) => ({ file: f.path, line: 1, entry: f.path.split('/').pop(), detail: 'serializer' }))
      .concat(g(/render\s+(json|html|xml|plain|text|template|partial):/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'render')));
    out.downloads_uploads_exports = g(/\b(send_file|send_data|ActiveStorage|CarrierWave|has_one_attached|has_many_attached|to_csv|export)\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'file-io'));
    out.search_aggregation = g(/\.(search|aggregate)\(|Elasticsearch|::Search\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'search'));
    out.tokens_actors = g(/\b(TokenAuthenticatable|authenticate_user!|current_user|before_action\s+:authenticate|devise|PersonalAccessToken|can\?|allowed\?|authorize!?|permission|access_level|admin\?|owner\?|maintainer\?|developer\?|reporter\?|guest\?|reset_session|has_secure_password)\b|session\s*\[|\.authenticate\s*\(|params\s*\[\s*:token\s*\]/, { nameRe: /\.rb$/ })
      .map((h) => item(h, h.text.trim(), /can\?|allowed\?|authorize|permission|access_level/.test(h.text) ? 'permission' : /token/i.test(h.text) ? 'token' : 'auth'))
      // before_action/skip_before_action authenticate lines are surfaced with controller-class
      // context by railsControllerAuthRows below instead — drop the generic duplicate here.
      .filter((r) => !/^\s*(?:skip_)?before_action\b.*authenticate/i.test(r.entry))
      .concat(railsControllerAuthRows(ctx));
    out.processes_ipc = ctx.files.filter((f) => /(^Procfile|(^|\/)config\/(puma|sidekiq|clockwork|schedule)\.\w+)$/.test(f.path))
      .map((f) => ({ file: f.path, line: 1, entry: f.name, detail: 'process' }));
    out.datastores_integrations = ctx.files.filter((f) => /(^|\/)config\/(database|redis|cable|storage)\.yml$/.test(f.path))
      .map((f) => ({ file: f.path, line: 1, entry: f.name, detail: 'datastore' }))
      .concat(g(/\b(Faraday|HTTParty|Net::HTTP|RestClient|Octokit|Aws::|Redis\.new)\b/, { nameRe: /\.rb$/ }).map((h) => item(h, h.text.trim(), 'integration')));
    return out;
  },
});
