// @secforge/inventories/graphql-sdl — schema-first GraphQL extractor (NEW, not in codengram). Parses
// `.graphql`/`.gql` SDL files AND inline `gql`...`` / `buildSchema('...')` blocks, emitting one `graphql` row
// per Query/Mutation/Subscription field with structured args. This feeds Package B's GraphQL→ENDPOINT
// synthesis: a Query field with an ID-shaped arg becomes `method:GET route:/graphql/Query/<field>/{arg}`.
// Also handles code-first resolver maps (`Query: { expense(parent, args, ctx) {...} }`) as a secondary path,
// bounding each resolver's body by brace-depth so Package B can scope auth attribution to the exact resolver.
const OPERATION_TYPES = ['Query', 'Mutation', 'Subscription'];

// Brace-depth body span, mirroring rails.js's ruby block-depth approach but for `{`/`{`-delimited code.
// ponytail: naive brace counting (no string/comment awareness) — good enough for bounding a resolver function;
// upgrade to a real tokenizer only if string literals containing braces start producing wrong spans in practice.
function braceBodySpan(lines, startIdx) {
  let depth = (lines[startIdx].match(/\{/g) || []).length - (lines[startIdx].match(/\}/g) || []).length;
  if (depth <= 0) return null;
  for (let i = startIdx + 1; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (depth <= 0) return { startLine: startIdx + 1, endLine: i + 1 };
  }
  return null;
}

const isIdArg = (name, type) => /^id$/i.test(name) || /Id$/.test(name) || /^ID!?$/.test(String(type || '').replace(/[[\]]/g, ''));

// GraphQL SDL args may be comma-separated (single-line convention) or newline-separated with no
// commas at all (multi-line convention) — scan for "name: type" pairs directly instead of
// splitting on commas first, so both conventions (and a join of the two, see
// joinMultilineFields()) parse identically.
function parseArgs(argStr) {
  const args = [];
  const re = /(\w+)\s*:\s*([\w[\]!]+)/g;
  let m;
  while ((m = re.exec(String(argStr || '')))) args.push({ name: m[1], type: m[2], isID: isIdArg(m[1], m[2]) });
  return args;
}

// A field declaration whose argument list spans multiple lines — `submitExpense(\n  teamId: ID!\n
// ): Expense` — must parse as ONE field, not one phantom field per arg line. Join every run of
// lines from an unbalanced `(` opener to its matching `)` into one logical line; consumed lines
// become blank so every other line's index (and reported `line` number) is unaffected.
function joinMultilineFields(lines) {
  const out = lines.slice();
  for (let i = 0; i < out.length; i++) {
    let depth = (out[i].match(/\(/g) || []).length - (out[i].match(/\)/g) || []).length;
    if (depth <= 0) continue;
    let joined = out[i], j = i;
    while (depth > 0 && j + 1 < out.length) {
      j++;
      joined += ' ' + out[j].trim();
      depth += (out[j].match(/\(/g) || []).length - (out[j].match(/\)/g) || []).length;
      out[j] = '';
    }
    out[i] = joined;
    i = j;
  }
  return out;
}

// Extract one `graphql` row per field declared inside a `type Query|Mutation|Subscription { ... }` block.
// `lines` is the SDL text's own lines; `lineOffset` maps a 0-based local line index to the real 1-based file
// line (0 when the SDL text IS the file — no offset needed).
function sdlFields(rawLines, file, lineOffset) {
  const lines = joinMultilineFields(rawLines);
  const rows = [];
  let opType = null, depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], text = raw.trim();
    if (!opType) {
      const open = text.match(/^(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b.*\{?/);
      if (open) { opType = open[1]; depth = (raw.match(/\{/g) || []).length - (raw.match(/\}/g) || []).length; continue; }
      continue;
    }
    depth += (raw.match(/\{/g) || []).length - (raw.match(/\}/g) || []).length;
    if (depth <= 0) { opType = null; continue; }
    if (text.startsWith('#') || !text) continue;
    const field = text.match(/^(\w+)\s*(?:\(([^)]*)\))?\s*:\s*([\w[\]!]+)/);
    if (!field) continue;
    const [, fieldName, argStr, returnType] = field;
    const args = parseArgs(argStr);
    rows.push({
      file, line: i + 1 + lineOffset, entry: `${opType} ${fieldName}(${args.map((a) => a.name).join(', ')}): ${returnType}`,
      detail: 'graphql-sdl-field', operation_type: opType, field_name: fieldName, args,
    });
  }
  return rows;
}

// Locate inline `gql`...`` / `buildSchema('...')` SDL blocks in a JS/TS source file, returning
// [{ text, lineOffset }] — lineOffset is the (0-based) line the block's content starts on, for accurate `line`.
function inlineSdlBlocks(text) {
  const blocks = [];
  const patterns = [/\bgql\s*`([\s\S]*?)`/g, /\bbuildSchema\s*\(\s*`([\s\S]*?)`\s*\)/g, /\bbuildSchema\s*\(\s*(['"])([\s\S]*?)\1\s*\)/g];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) {
      const body = m[2] !== undefined ? m[2] : m[1];
      const before = text.slice(0, m.index + m[0].indexOf(body));
      blocks.push({ text: body, lineOffset: (before.match(/\n/g) || []).length });
    }
  }
  return blocks;
}

// Code-first resolver map: `Query: { expense(parent, args, ctx) { ... } }` (or arrow/function-expression props).
// Statically typed args aren't available at runtime, so args are recovered heuristically from `args.<name>` /
// `args['name']` usages inside the resolver body — only ID-shaped names are kept (best-effort, not full typing).
function resolverMapFields(lines, file) {
  const rows = [];
  let opType = null, mapDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], text = raw.trim();
    if (!opType) {
      const open = text.match(/^(?:['"]?)(Query|Mutation|Subscription)(?:['"]?)\s*:\s*\{/);
      if (open) { opType = open[1]; mapDepth = (raw.match(/\{/g) || []).length - (raw.match(/\}/g) || []).length; }
      continue;
    }
    const closeCheck = (raw.match(/\{/g) || []).length - (raw.match(/\}/g) || []).length;
    const fn = text.match(/^(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?:=>)?\s*\{/) ||
      text.match(/^(\w+)\s*:\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/) ||
      text.match(/^(\w+)\s*:\s*(?:async\s*)?function\s*\(([^)]*)\)\s*\{/);
    if (fn) {
      const [, fieldName] = fn;
      const span = braceBodySpan(lines, i);
      const body = span ? lines.slice(i + 1, span.endLine - 1).join('\n') : '';
      const names = new Set();
      for (const m of body.matchAll(/\bargs(?:\.(\w+)|\[['"](\w+)['"]\])/g)) names.add(m[1] || m[2]);
      const args = [...names].filter((n) => isIdArg(n)).map((n) => ({ name: n, type: 'ID', isID: true }));
      const row = { file, line: i + 1, entry: `${opType} ${fieldName}(...)`, detail: 'graphql-resolver',
        operation_type: opType, field_name: fieldName, args };
      if (span) row.body = span;
      rows.push(row);
    }
    mapDepth += closeCheck;
    if (mapDepth <= 0) opType = null;
  }
  return rows;
}

export function graphqlSdlInventory(ctx) {
  const rows = [];
  for (const f of ctx.files.filter((x) => /\.(?:graphql|gql)$/i.test(x.ext))) {
    rows.push(...sdlFields(ctx.read(f.path).split(/\r?\n/), f.path, 0));
  }
  for (const f of ctx.files.filter((x) => /\.(?:js|jsx|ts|tsx)$/i.test(x.ext) && !ctx.bundled.has(x.path))) {
    const text = ctx.read(f.path);
    for (const block of inlineSdlBlocks(text)) rows.push(...sdlFields(block.text.split(/\r?\n/), f.path, block.lineOffset));
    if (/\b(?:Query|Mutation|Subscription)\s*:\s*\{/.test(text)) rows.push(...resolverMapFields(text.split(/\r?\n/), f.path));
  }
  return rows;
}
