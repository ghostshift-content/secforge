// @secforge/inventories/universal — language-agnostic fallback extractor. Ported from codengram's
// packages/inventories/index.js (buildContext + universalInventory + supporting helpers). Gives ANY language
// a real, cited map using (a) fast path/name role heuristics and (b) broad cross-framework content patterns.
import fs from 'node:fs';
import path from 'node:path';
import { INVENTORY_KEYS } from './plugins.js';
import { isCodeFile } from './profiler.js';

const SKIP_DIR = new Set(['node_modules', '.git', 'vendor', '3rdparty', 'dist', 'build', 'coverage', 'tmp', 'log', 'logs', 'target', 'cypress', '__tests__', '__mocks__']);
function listFiles(root, base = root, out = []) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) listFiles(full, base, out); continue; }
    out.push({ path: path.relative(base, full).split(path.sep).join('/'), abs: full, name: e.name, ext: path.extname(e.name).toLowerCase() });
  }
  return out;
}

// Extraction context over a frozen source tree: listFiles/read/grep/bundled.
export function buildContext(sourceRoot) {
  const files = listFiles(sourceRoot);
  const cache = new Map();
  const read = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let t = ''; try { t = fs.readFileSync(path.join(sourceRoot, rel), 'utf8'); } catch {}
    cache.set(rel, t); return t;
  };
  // grep(re) → [{file,line,text,m}]; optional {pathRe}/{nameRe} scope the scan (perf + precision).
  const grep = (re, { pathRe = null, nameRe = null } = {}) => {
    const hits = [];
    for (const f of files) {
      if (pathRe && !pathRe.test(f.path)) continue;
      if (nameRe && !(typeof nameRe === 'function' ? nameRe(f.name) : nameRe.test(f.name))) continue;
      const lines = read(f.path).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) { const m = re.exec(lines[i]); re.lastIndex = 0; if (m) hits.push({ file: f.path, line: i + 1, text: lines[i].trim(), m }); }
    }
    return hits;
  };
  // Client-delivered / vendored assets are not the app's server source — exclude minified/bundled JS/CSS and
  // anything under an assets dir from extraction, anchoring, AND coverage.
  const ASSET_DIR = /(?:^|\/)(?:assets?|static|public|vendor|dist|build|bower_components|third[-_]?party)\//i;
  const bundled = new Set();
  for (const f of files) {
    if (!/\.(?:js|mjs|cjs|jsx|ts|tsx|css)$/i.test(f.name)) continue;
    if (/[.-]min\.(?:js|mjs|cjs|css)$/i.test(f.name) || ASSET_DIR.test(f.path)) { bundled.add(f.path); continue; }
    const t = read(f.path); const nl = (t.match(/\n/g) || []).length + 1;
    if (t.length > 30000 && t.length / nl > 250) bundled.add(f.path);
  }
  return { root: sourceRoot, files, read, grep, bundled };
}

export const item = (h, entry, detail = '') => ({ file: h.file, line: h.line, entry, detail });

const ROUTE_DEF = /\b(?:(?:app|router|route|api|bp|blueprint|srv|mux|group|http|r|Router|Route)\s*\.\s*(?:get|post|put|patch|delete|options|head|use|all|route|handle|handlefunc|match|any|resource|apiresource|add_route|add_url_rule)\s*\()|@(?:Get|Post|Put|Patch|Delete|Request|Api|Web)Mapping\b|@(?:app|router|blueprint|bp)\.(?:get|post|put|patch|delete|route)\b|Route::(?:get|post|put|patch|delete|any|match|resource|apiResource|group)\s*\(|#\[(?:Route|ApiRoute|FrontpageRoute|Get|Post|Put|Delete|Patch)\b|@(?:Path|GET|POST|PUT|DELETE|PATCH)\b|\b(?:path|re_path|url)\s*\(\s*[rf]?['"]|http\.HandleFunc\s*\(/i;
const AUTH_DEF = /@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed|Authorize|Authenticated|PermitAll|DenyAll)\b|IsGranted|isGranted\s*\(|hasR(?:ole|oles|equest)|hasAnyRole|hasAuthority\s*\(|requireLogin|ensureLoggedIn|authenticate[_(]|current_user\b|getUser\(|@login_required|checkPermission|authorize[!(]|before_action[^,\n]*auth|passport\.|jwt\.verify|verifyToken|Auth::(?:check|user|guard)|#\[[A-Za-z]*(?:Admin|Auth|Role|Public|Require|Secur|Anonym|Grant|Permission|Guard|Login|Restrict|Permit|Deny)[A-Za-z]*\]/i;
// CSRF guard vocabulary — a real "this endpoint's write is CSRF-protected" signal, not "there is a
// CSRF token somewhere in this codebase": scoped to the guard call/middleware/config, not any use
// of the word "token" alone.
const CSRF_GUARD_RE = /\b(?:csrf_token|csrf_meta_tag|protect_from_forgery|authenticity_token|csurf|csrfProtection|CSRFProtect|verifyCsrfToken|X-CSRF-Token)\b/i;
// POSITIVE cookie/session evidence (RIX-csrf design) — a real "this request rides a browser
// cookie/session" signal, never inferred from the mere absence of a bearer token. A bearer/JWT
// API surfaces none of these.
const SESSION_COOKIE_RE = /\bexpress-session\b|\breq\.session\b|\bcookie-session\b|\bcookies\.set\s*\(|Set-Cookie|\bres\.render\s*\(/i;
// Unambiguous broken/deprecated crypto primitives only (DES/3DES/RC4/ECB-mode) — deliberately
// narrow to avoid false-positiving on ambiguous bare md5/sha1 usage (ETags, cache keys, etc).
const WEAK_CRYPTO_RE = /createCipheriv\s*\(\s*['"](?:des|des-ede3|rc4)|Cipher\.getInstance\(\s*["'](?:DES|RC4|Blowfish)|Digest::(?:DES)\b|-ecb['")]/i;
const DOWNLOAD_DEF = /\b(?:(?:function|def|func)\s+\w*(?:upload|download|export|attachment)\w*|(?:public|private|protected|async|static)\s+(?:\w+\s+)?\w*(?:upload|download|export|attachment)\w*\s*\(|sendFile\s*\(|send_file\b|send_data\b|FileResponse\s*\(|Content-Disposition\b|move_uploaded_file\s*\(|presigned\w*\s*\()/i;
const SEARCH_DEF = /\b(?:(?:function|def|func)\s+\w*(?:search|query|aggregate|facet)\w*|(?:public|private|protected|async|static)\s+(?:\w+\s+)?\w*(?:search|query|aggregate|facet)\w*\s*\(|Elasticsearch\w*\s*\(|OpenSearch\w*\s*\(|Solr\w*\s*\(|Meilisearch\w*\s*\(|Algolia\w*\s*\()/i;
const GRAPHQL_DEF = /\b(?:type\s+(?:Query|Mutation|Subscription)\b|extend\s+type\b|@Resolver\b|@Query\b|@Mutation\b|GraphQLObjectType|buildSchema\b|gql`)/i;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

// Role of a file from its path/name — works across ecosystems (Rails, Laravel, Symfony, Nest, Spring, Django, …).
const ROLE = [
  ['services_finders_policies', /(?:^|\/)(?:policies|policy|guards?|abilities)(?:\/|$)|(?:Policy|Guard|Ability|Voter)\.\w+$/i, 'policy'],
  ['services_finders_policies', /(?:^|\/)(?:services?|usecases?|use_cases?|interactors?|managers?|providers?|repositor(?:y|ies)|finders?|handlers?)(?:\/|$)|(?:Service|UseCase|Interactor|Manager|Provider|Repository|Finder|Handler)\.\w+$/i, 'service'],
  ['services_finders_policies', /(?:^|\/)(?:models?|entit(?:y|ies)|domain\/models?|schemas?)(?:\/|$)|(?:Model|Entity)\.\w+$/i, 'model'],
  ['workers_jobs', /(?:^|\/)(?:jobs?|workers?|tasks?|queues?|consumers?|cron|schedulers?|commands?)(?:\/|$)|(?:Job|Worker|Task|Consumer|Cron|Scheduler|Command)\.\w+$/i, 'worker'],
  ['response_shaping', /(?:^|\/)(?:serializers?|transformers?|presenters?|resources?|views?|dtos?)(?:\/|$)|(?:Serializer|Transformer|Presenter|Resource|View|Dto|Response)\.\w+$/i, 'serializer'],
  ['routes_endpoints', /(?:^|\/)(?:controllers?|handlers?|routes?|endpoints?|api|resources?|views?)(?:\/|$)|(?:Controller|Handler|Endpoint|Resource|Api)\.\w+$/i, 'handler'],
  ['tokens_actors', /(?:^|\/)(?:auth|authentication|security|middlewares?|guards?|permissions?|identity)(?:\/|$)/i, 'auth'],
  ['datastores_integrations', /(?:^|\/)(?:migrations?|db|database|integrations?|clients?|gateways?|adapters?)(?:\/|$)|schema\.prisma$|knexfile|\.sql$|database\.(?:yml|php|json)$/i, 'integration'],
  ['processes_ipc', /(?:^Procfile$|(?:^|\/)Dockerfile$|docker-compose|(?:^|\/)Makefile$|(?:^|\/)cmd\/[^/]+\/main\.|(?:^|\/)bin\/)/i, 'process'],
];

const lineFor = (text, offset) => text.slice(0, Math.max(0, offset)).split(/\r?\n/).length;
const routeFields = (text) => {
  const method = text.match(/\b(get|post|put|patch|delete|options|head)\b/i)?.[1]?.toUpperCase() ||
    text.match(/['"]verb['"]\s*=>\s*['"]([A-Z]+)['"]/i)?.[1]?.toUpperCase() || 'ANY';
  const route = text.match(/['"](?:url|path)['"]\s*=>\s*['"]([^'"]+)['"]/i)?.[1] ||
    text.match(/(?:get|post|put|patch|delete|options|head|route|handlefunc)\s*\(\s*[rf]?['"]([^'"]+)/i)?.[1] ||
    text.match(/#\[(?:Api)?Route[^\]]*url\s*:\s*['"]([^'"]+)/i)?.[1] ||
    text.match(/@(?:Get|Post|Put|Patch|Delete|Request|Api|Web)Mapping\s*\(?(?:value\s*=\s*)?['"]([^'"]+)/i)?.[1] || '';
  return { method, path: route };
};

// An OpenAPI/Swagger contract is recognized by its CONTENT (an `openapi`/`swagger` version + a `paths` map),
// not by a blessed filename.
function looksLikeApiSpec(text) {
  const head = text.slice(0, 8000);
  return /["']?(?:openapi|swagger)["']?\s*:/.test(head) && /["']?paths["']?\s*:/.test(head);
}
function openApiInventory(ctx) {
  const rows = [];
  const specFiles = ctx.files.filter((f) => /\.(?:json|ya?ml|json5)$/i.test(f.name) &&
    (/(?:^|\/)(?:openapi|swagger)(?:[-_.][^/]*)?\.(?:json|ya?ml)$/i.test(f.path) || looksLikeApiSpec(ctx.read(f.path))));
  for (const file of specFiles) {
    const text = ctx.read(file.path);
    if (/\.json$/i.test(file.path)) {
      let doc; try { doc = JSON.parse(text); } catch { continue; }
      for (const [route, operations] of Object.entries(doc?.paths || {})) {
        for (const [verb, operation] of Object.entries(operations || {})) {
          if (!HTTP_METHODS.has(String(verb).toLowerCase())) continue;
          const needle = JSON.stringify(route), offset = text.indexOf(needle);
          const security = operation?.security ?? doc?.security;
          rows.push({ file: file.path, line: offset >= 0 ? lineFor(text, offset) : 1,
            entry: `${String(verb).toUpperCase()} '${route}'`, detail: 'openapi', method: String(verb).toUpperCase(), path: route,
            api_class: operation?.tags?.join(', ') || doc?.info?.title || 'OpenAPI', handler: operation?.operationId || '',
            purpose: operation?.summary || operation?.description || 'OpenAPI operation',
            auth_notes: security?.length ? `OpenAPI security: ${security.flatMap((s) => Object.keys(s || {})).join(', ') || 'declared'}` : 'OpenAPI security not declared' });
        }
      }
      continue;
    }
    const lines = text.split(/\r?\n/); let currentPath = '';
    for (let i = 0; i < lines.length; i++) {
      const pathHit = lines[i].match(/^\s{0,6}["']?(\/[^:"']+)["']?:\s*$/);
      if (pathHit) { currentPath = pathHit[1]; continue; }
      const verb = lines[i].match(/^\s+(get|post|put|patch|delete|options|head):\s*$/i);
      if (currentPath && verb) rows.push({ file: file.path, line: i + 1, entry: `${verb[1].toUpperCase()} '${currentPath}'`,
        detail: 'openapi', method: verb[1].toUpperCase(), path: currentPath, api_class: 'OpenAPI', purpose: 'OpenAPI operation' });
    }
  }
  return rows;
}

// Nextcloud/PHP frameworks declare routes as arrays rather than executable route calls.
function phpArrayRoutes(ctx) {
  const rows = [];
  for (const file of ctx.files.filter((f) => /(?:^|\/)appinfo\/routes\.php$/i.test(f.path))) {
    const lines = ctx.read(file.path).split(/\r?\n/); let section = 'routes';
    const appId = file.path.match(/(?:^|\/)apps\/([^/]+)\/appinfo\/routes\.php$/i)?.[1] || '';
    for (let i = 0; i < lines.length; i++) {
      if (/['"]ocs['"]\s*=>\s*\[/.test(lines[i])) section = 'ocs';
      else if (/['"]routes['"]\s*=>\s*\[/.test(lines[i])) section = 'routes';
      if (!/['"](?:name|url)['"]\s*=>/.test(lines[i])) continue;
      const start = i, block = [];
      for (let j = i; j < Math.min(lines.length, i + 14); j++) {
        block.push(lines[j]);
        if (/\],?\s*$/.test(lines[j]) && block.some((x) => /['"]url['"]\s*=>/.test(x))) { i = j; break; }
      }
      const body = block.join(' '), relativeRoute = body.match(/['"]url['"]\s*=>\s*['"]([^'"]+)/)?.[1];
      if (!relativeRoute) continue;
      const route = appId ? `${section === 'ocs' ? '/ocs/v2.php/apps' : '/index.php/apps'}/${appId}/${relativeRoute.replace(/^\//, '')}` : relativeRoute;
      const methods = body.match(/['"]verb['"]\s*=>\s*\[([^\]]+)/)?.[1]?.match(/['"]([A-Z]+)['"]/g)?.map((v) => v.replace(/['"]/g, '')) ||
        [body.match(/['"]verb['"]\s*=>\s*['"]([A-Z]+)['"]/i)?.[1] || 'ANY'];
      const handler = body.match(/['"]name['"]\s*=>\s*['"]([^'"]+)/)?.[1] || '';
      for (const method of methods) rows.push({ file: file.path, line: start + 1, entry: `${method} '${route}'`,
        detail: section === 'ocs' || /\/api\//i.test(route) ? 'php-rest-route' : 'php-web-route', method, path: route,
        api_class: section === 'ocs' ? 'OCS API' : 'PHP routes', handler, purpose: handler || 'PHP route', auth_notes: '' });
    }
  }
  return rows;
}

export { openApiInventory, phpArrayRoutes };

export function universalInventory(ctx) {
  const out = Object.fromEntries(INVENTORY_KEYS.map((k) => [k, []]));
  // (a) machine-readable API contracts and framework route declarations.
  out.rest_api.push(...openApiInventory(ctx));
  for (const row of phpArrayRoutes(ctx)) (row.detail === 'php-rest-route' ? out.rest_api : out.routes_endpoints).push(row);
  // (b) content: explicit route/auth/data-boundary definitions (scoped to code files, skipping minified bundles).
  const notBundled = (h) => !ctx.bundled.has(h.file);
  for (const h of ctx.grep(ROUTE_DEF, { nameRe: isCodeFile }).filter(notBundled)) {
    const parsed = routeFields(h.text), rest = /(?:^|\/)(?:api|rest|graphql)(?:\/|$)/i.test(h.file) || /^\/api(?:\/|$)/i.test(parsed.path) || /ApiRoute|RequestMapping/i.test(h.text);
    (rest ? out.rest_api : out.routes_endpoints).push({ ...item(h, parsed.path ? `${parsed.method} '${parsed.path}'` : h.text.slice(0, 90), rest ? 'generic-rest-route' : 'route'), ...parsed,
      api_class: rest ? 'Source API route' : '', purpose: rest ? 'REST API operation' : 'Web route' });
  }
  for (const h of ctx.grep(AUTH_DEF, { nameRe: isCodeFile }).filter(notBundled)) out.tokens_actors.push(item(h, h.text.slice(0, 90), 'auth'));
  for (const h of ctx.grep(CSRF_GUARD_RE, { nameRe: isCodeFile }).filter(notBundled)) out.tokens_actors.push(item(h, h.text.slice(0, 90), 'csrf'));
  for (const h of ctx.grep(SESSION_COOKIE_RE, { nameRe: isCodeFile }).filter(notBundled)) out.tokens_actors.push(item(h, h.text.slice(0, 90), 'session-cookie'));
  for (const h of ctx.grep(WEAK_CRYPTO_RE, { nameRe: isCodeFile }).filter(notBundled)) out.services_finders_policies.push(item(h, h.text.slice(0, 90), 'weak-crypto'));
  for (const h of ctx.grep(DOWNLOAD_DEF, { nameRe: isCodeFile }).filter(notBundled)) out.downloads_uploads_exports.push(item(h, h.text.slice(0, 90), 'file-io'));
  for (const h of ctx.grep(SEARCH_DEF, { nameRe: isCodeFile }).filter(notBundled)) out.search_aggregation.push(item(h, h.text.slice(0, 90), 'search'));
  for (const h of ctx.grep(GRAPHQL_DEF, { nameRe: /\.(?:graphql|gql|js|jsx|ts|tsx|py|rb|php|java|kt|go)$/i }).filter(notBundled)) out.graphql.push(item(h, h.text.slice(0, 90), 'graphql-operation'));
  // (c) file-role heuristics (fast, language-agnostic) — one representative row per meaningful file.
  const represented = new Set(INVENTORY_KEYS.flatMap((k) => out[k].map((r) => r.file)));
  for (const f of ctx.files) {
    if (ctx.bundled.has(f.path)) continue;
    if (!isCodeFile(f.name) && !ROLE[8][1].test(f.path)) continue;
    for (const [kind, re, detail] of ROLE) {
      if (re.test(f.path) || re.test(f.name)) { out[kind].push({ file: f.path, line: 1, entry: f.name, detail }); represented.add(f.path); break; }
    }
  }
  // (d) total source coverage — unclassified code files still get a cited source-module symbol row.
  for (const f of ctx.files) if (isCodeFile(f.name) && !ctx.bundled.has(f.path) && !represented.has(f.path)) {
    out.services_finders_policies.push({ file: f.path, line: 1, entry: f.name, detail: 'source-module' });
  }
  return out;
}
