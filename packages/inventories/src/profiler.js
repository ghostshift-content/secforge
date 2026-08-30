// @secforge/inventories/profiler — deterministic repository facts (no LLM). Ported from codengram's
// packages/profiler/index.js, trimmed to what the inventory engine needs (language table, source-file
// predicates, profileRepo). Model-context/token-budget helpers dropped: nothing in this package consumes them.
// ponytail: trimmed vs. codengram — no MODEL_CONTEXT/usableContext, not needed by the mapper's inventory phase.
import fs from 'node:fs';
import path from 'node:path';

// THE canonical extension → { language, kind } table — the single source of truth for "what language is this
// file and is it feature-bearing code". kind: code · template · query · markup (feature-bearing) |
// config · data (snapshotted + profiled, not features).
const LANG_TABLE = [
  ['Ruby', 'code', '.rb'], ['Python', 'code', '.py'], ['JavaScript/TypeScript', 'code', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'],
  ['CoffeeScript', 'code', '.coffee'], ['Go', 'code', '.go'], ['Java', 'code', '.java'], ['Kotlin', 'code', '.kt', '.kts'],
  ['PHP', 'code', '.php'], ['C#', 'code', '.cs'], ['C', 'code', '.c', '.h'], ['C++', 'code', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
  ['Rust', 'code', '.rs'], ['Swift', 'code', '.swift'], ['Scala', 'code', '.scala', '.sc'], ['Elixir', 'code', '.ex', '.exs'],
  ['Erlang', 'code', '.erl', '.hrl'], ['Clojure', 'code', '.clj', '.cljs', '.cljc'], ['Groovy', 'code', '.groovy', '.gvy'],
  ['Perl', 'code', '.pl', '.pm'], ['Shell', 'code', '.sh', '.bash', '.zsh'], ['Dart', 'code', '.dart'],
  ['CFML', 'code', '.cfm', '.cfc', '.cfml'], ['Visual Basic', 'code', '.vb'], ['F#', 'code', '.fs', '.fsx', '.fsi'],
  ['Haskell', 'code', '.hs', '.lhs'], ['OCaml', 'code', '.ml', '.mli'], ['Elm', 'code', '.elm'], ['ReasonML', 'code', '.re'],
  ['ReScript', 'code', '.res'], ['Racket', 'code', '.rkt'], ['Scheme', 'code', '.scm'], ['Lisp', 'code', '.lisp', '.lsp', '.el'],
  ['Lua', 'code', '.lua'], ['R', 'code', '.r'], ['Julia', 'code', '.jl'], ['Nim', 'code', '.nim'], ['Crystal', 'code', '.cr'],
  ['Zig', 'code', '.zig'], ['V', 'code', '.v'], ['D', 'code', '.d'], ['Objective-C', 'code', '.m', '.mm'],
  ['Pascal', 'code', '.pas', '.pp'], ['Fortran', 'code', '.f', '.f90', '.for'], ['COBOL', 'code', '.cob', '.cbl'],
  ['Tcl', 'code', '.tcl'], ['PowerShell', 'code', '.ps1', '.psm1'], ['Solidity', 'code', '.sol'], ['Move', 'code', '.move'],
  ['Cairo', 'code', '.cairo'], ['Gleam', 'code', '.gleam'], ['Vala', 'code', '.vala'], ['Haxe', 'code', '.hx'], ['Arduino', 'code', '.ino'],
  ['Vue', 'template', '.vue'], ['Svelte', 'template', '.svelte'], ['Astro', 'template', '.astro'],
  ['Razor', 'template', '.razor', '.cshtml', '.vbhtml'], ['ASP.NET', 'template', '.aspx', '.ascx'],
  ['JSP', 'template', '.jsp', '.jspx', '.tag'], ['GSP', 'template', '.gsp'], ['ERB', 'template', '.erb'],
  ['Haml', 'template', '.haml'], ['Slim', 'template', '.slim'], ['Twig', 'template', '.twig'], ['Blade', 'template', '.blade'],
  ['EJS', 'template', '.ejs'], ['Handlebars', 'template', '.hbs', '.handlebars'], ['Mustache', 'template', '.mustache'],
  ['Liquid', 'template', '.liquid'], ['Nunjucks', 'template', '.njk'], ['Pug', 'template', '.pug', '.jade'],
  ['HTML', 'markup', '.html', '.htm'],
  ['SQL', 'query', '.sql'], ['GraphQL', 'query', '.graphql', '.gql'], ['Prisma', 'query', '.prisma'],
  ['Protobuf', 'query', '.proto'], ['Thrift', 'query', '.thrift'],
  ['YAML', 'config', '.yml', '.yaml'], ['TOML', 'config', '.toml'], ['INI', 'config', '.ini', '.cfg', '.cnf', '.conf'],
  ['Properties', 'config', '.properties'], ['Dotenv', 'config', '.env'], ['Terraform', 'config', '.tf', '.tfvars'],
  ['HCL', 'config', '.hcl'], ['Gradle', 'config', '.gradle'], ['Dockerfile', 'config', '.dockerfile'],
  ['Bicep', 'config', '.bicep'], ['JSON', 'data', '.json', '.json5', '.jsonc'], ['XML', 'data', '.xml'],
];
export const EXT_LANG = new Map();
for (const [lang, kind, ...exts] of LANG_TABLE) for (const e of exts) EXT_LANG.set(e, { lang, kind });
const FEATURE_BEARING = new Set(['code', 'template', 'query', 'markup']);
export const CODE_EXT = new Set(EXT_LANG.keys());
export const extInfo = (name) => EXT_LANG.get(path.extname(String(name || '').toLowerCase())) || null;
export const languageFor = (name) => extInfo(name)?.lang || null;
// Feature-bearing predicate: developer-authored logic/interface (excludes pure config/data). Coverage + universal
// extraction use THIS; ingestion/profiler snapshot the broader isSourceFile. Both derive from the one table above.
export const isCodeFile = (name) => { const i = extInfo(name); return !!i && FEATURE_BEARING.has(i.kind); };
export const CODE_FILES = new Set(['gemfile', 'gemfile.lock', 'dockerfile', 'makefile', 'rakefile', 'procfile',
  'requirements.txt', 'pom.xml', 'build.gradle', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'composer.json',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'nginx.conf', 'docker-compose.yml', 'docker-compose.yaml']);
const CODE_PATTERNS = [/^\.env(\.|$)/i, /^dockerfile(\.|$)/i, /^requirements[\w.-]*\.txt$/i, /^docker-compose[\w.-]*\.ya?ml$/i, /\.conf(\.[\w-]+)?$/i];
const SKIP_DIR = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage', '.next', 'tmp', 'log', 'logs', '__pycache__', '.venv', 'venv', 'target']);

export function isSourceFile(name) {
  const l = String(name || '').toLowerCase();
  if (CODE_FILES.has(l)) return true;
  const ext = path.extname(l);
  if (ext && CODE_EXT.has(ext)) return true;
  return CODE_PATTERNS.some((re) => re.test(l));
}

// The real file manifest: [{ path (repo-relative), bytes, ext }].
export function listSourceFiles(root, base = root, out = []) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) listSourceFiles(full, base, out); continue; }
    if (!isSourceFile(e.name)) continue;
    try { out.push({ path: path.relative(base, full).split(path.sep).join('/'), bytes: fs.statSync(full).size, ext: path.extname(e.name).toLowerCase() }); } catch {}
  }
  return out;
}

// Manifest/config files → detected frameworks (best-effort, deterministic).
const MANIFESTS = [
  { file: 'Gemfile', lang: 'Ruby', fw: [[/rails/i, 'Rails'], [/sinatra/i, 'Sinatra'], [/hanami/i, 'Hanami']] },
  { file: 'package.json', lang: 'JavaScript/TypeScript', fw: [[/"express"/, 'Express'], [/"@nestjs/, 'NestJS'], [/"next"/, 'Next.js'], [/"react"/, 'React'], [/"fastify"/, 'Fastify'], [/"koa"/, 'Koa']] },
  { file: 'requirements.txt', lang: 'Python', fw: [[/django/i, 'Django'], [/flask/i, 'Flask'], [/fastapi/i, 'FastAPI']] },
  { file: 'pyproject.toml', lang: 'Python', fw: [[/django/i, 'Django'], [/flask/i, 'Flask'], [/fastapi/i, 'FastAPI']] },
  { file: 'go.mod', lang: 'Go', fw: [[/gin-gonic/i, 'Gin'], [/labstack\/echo/i, 'Echo'], [/gofiber/i, 'Fiber']] },
  { file: 'pom.xml', lang: 'Java', fw: [[/spring-boot/i, 'Spring Boot'], [/spring-web/i, 'Spring']] },
  { file: 'build.gradle', lang: 'Java/Kotlin', fw: [[/spring/i, 'Spring'], [/ktor/i, 'Ktor']] },
  { file: 'composer.json', lang: 'PHP', fw: [[/laravel/i, 'Laravel'], [/symfony/i, 'Symfony']] },
  { file: 'Cargo.toml', lang: 'Rust', fw: [[/axum/i, 'Axum'], [/actix/i, 'Actix'], [/rocket/i, 'Rocket']] },
  { file: 'mix.exs', lang: 'Elixir', fw: [[/phoenix/i, 'Phoenix']] },
];
function detectStack(root) {
  const langs = new Set(), frameworks = new Set(), manifests = [];
  for (const m of MANIFESTS) {
    const p = path.join(root, m.file);
    let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
    manifests.push(m.file); langs.add(m.lang);
    for (const [re, name] of m.fw) if (re.test(txt)) frameworks.add(name);
  }
  return { languages: [...langs], frameworks: [...frameworks], manifests };
}
// Common process entry points (deterministic path patterns).
// ponytail: routes.rb/application.rb were root-anchored (`^`) while every other pattern here uses
// the `(^|\/)` idiom — a Rails app nested under a monorepo subdirectory (e.g. `rails-api/` inside
// a combined multi-service root) never matched, so railsLayout stayed false and the Rails plugin
// silently never ran there at all. Root cause of the combined-root false detect(), not a symptom.
const ENTRY_PATTERNS = [/(^|\/)config\/application\.rb$/i, /(^|\/)config\/routes\.rb$/i, /(^|\/)main\.(go|py|rs|ts|js)$/i,
  /(^|\/)app\.(py|js|ts|rb)$/i, /(^|\/)server\.(js|ts)$/i, /(^|\/)index\.(js|ts)$/i, /manage\.py$/i,
  /(^|\/)wsgi\.py$/i, /(^|\/)asgi\.py$/i, /(^|\/)cmd\//i, /Procfile$/i, /docker-compose\.ya?ml$/i, /Dockerfile$/i];

// Profile a repository from an already-computed file manifest (or compute one).
export function profileRepo(root, opts = {}) {
  const files = opts.files || listSourceFiles(root);
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  const byLang = {}; for (const f of files) { const k = f.ext || '(none)'; byLang[k] = (byLang[k] || 0) + f.bytes; }
  const languages_by_bytes = Object.entries(byLang).sort((a, b) => b[1] - a[1]).map(([ext, b]) => ({ ext, bytes: b, files: files.filter((f) => f.ext === ext).length }));
  const topDirs = {}; for (const f of files) { const top = String(f.path).split(/[\\/]/)[0] || '.'; topDirs[top] = (topDirs[top] || 0) + 1; }
  const top_directories = Object.entries(topDirs).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([dir, n]) => ({ dir, files: n }));
  const entry_points = files.map((f) => f.path).filter((p) => ENTRY_PATTERNS.some((re) => re.test(p))).slice(0, 60);
  const stack = detectStack(root);
  // Structural inference: infer language/framework from LAYOUT when manifests are absent (e.g. a Rails app with
  // no Gemfile at root). Deterministic, additive — never overrides a manifest-detected stack.
  const byExt = new Set(languages_by_bytes.map((l) => l.ext));
  for (const ext of byExt) { const info = EXT_LANG.get(ext); if (info && FEATURE_BEARING.has(info.kind) && !stack.languages.includes(info.lang)) stack.languages.push(info.lang); }
  const railsLayout = entry_points.some((e) => /(^|\/)config\/routes\.rb$/.test(e)) || top_directories.some((d) => d.dir === 'app');
  if (byExt.has('.rb') && railsLayout && !stack.frameworks.includes('Rails')) stack.frameworks.push('Rails');
  return {
    root, files: files.length, bytes,
    languages: stack.languages, frameworks: stack.frameworks, manifests: stack.manifests,
    languages_by_bytes, top_directories, entry_points,
  };
}

// self-check
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = await import('node:assert');
  assert.ok(isSourceFile('Gemfile') && isSourceFile('app.rb') && isSourceFile('.env.production') && !isSourceFile('logo.png'));
  assert.ok(isCodeFile('app.rb') && !isCodeFile('config.yml'));
  console.log('ok — profiler: source recognition, isCodeFile');
}
