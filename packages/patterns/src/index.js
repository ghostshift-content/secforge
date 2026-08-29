// @secforge/patterns — canonical + custom pattern loading, with CWE mapping.
// SecForge's canonical family registry (24 families); CWE lists hand-mapped per family.
// The catalog is vendored into this package (data/) — SecForge ships self-contained.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The vendored catalog lives inside this package. SecForge ships self-contained — no external checkout.
const DATA_DIR = join(__dirname, '..', 'data');

// Canonical family registry (prefix → readable name, count, CWE ids it maps to).
export const FAMILIES = Object.freeze([
  { prefix: 'ACX', name: 'Access control', count: 32, cwe: ['CWE-284', 'CWE-639', 'CWE-862', 'CWE-863'] },
  { prefix: 'ATX', name: 'Account takeover', count: 16, cwe: ['CWE-287', 'CWE-640', 'CWE-307'] },
  { prefix: 'AIX', name: 'AI agent', count: 12, cwe: ['CWE-1427', 'CWE-668'] },
  { prefix: 'XX', name: 'Browser XSS', count: 16, cwe: ['CWE-79'] },
  { prefix: 'CBX', name: 'Cache boundary', count: 8, cwe: ['CWE-524', 'CWE-441'] },
  { prefix: 'CLX', name: 'Cloud IAM', count: 12, cwe: ['CWE-269', 'CWE-732'] },
  { prefix: 'CIX', name: 'Command execution', count: 18, cwe: ['CWE-78', 'CWE-77'] },
  { prefix: 'XD', name: 'Cross-cutting static differentials', count: 20, cwe: ['CWE-436'] },
  { prefix: 'CRX', name: 'Cryptographic misuse', count: 10, cwe: ['CWE-327', 'CWE-326', 'CWE-330'] },
  { prefix: 'UPX', name: 'File upload', count: 8, cwe: ['CWE-434'] },
  { prefix: 'MSX', name: 'Memory safety', count: 13, cwe: ['CWE-119', 'CWE-416', 'CWE-787'] },
  { prefix: 'MBX', name: 'Mobile client', count: 10, cwe: ['CWE-312', 'CWE-923'] },
  { prefix: 'PDX', name: 'Parser differential', count: 8, cwe: ['CWE-436'] },
  { prefix: 'PTX', name: 'Path traversal', count: 13, cwe: ['CWE-22'] },
  { prefix: 'QIX', name: 'Query injection', count: 6, cwe: ['CWE-89', 'CWE-90', 'CWE-943'] },
  { prefix: 'QEX', name: 'Queue / event boundary', count: 8, cwe: ['CWE-345', 'CWE-441'] },
  { prefix: 'RIX', name: 'Request integrity', count: 7, cwe: ['CWE-352', 'CWE-345'] },
  { prefix: 'HDS', name: 'Request smuggling', count: 8, cwe: ['CWE-444'] },
  { prefix: 'REX', name: 'Resource exhaustion', count: 11, cwe: ['CWE-400', 'CWE-770'] },
  { prefix: 'SDX', name: 'Sensitive data exposure', count: 8, cwe: ['CWE-200', 'CWE-359'] },
  { prefix: 'BCX', name: 'Smart contract', count: 11, cwe: ['CWE-841', 'CWE-682'] },
  { prefix: 'SX', name: 'SSRF', count: 11, cwe: ['CWE-918'] },
  { prefix: 'SMX', name: 'State machine', count: 7, cwe: ['CWE-841'] },
  { prefix: 'SCX', name: 'Supply chain', count: 8, cwe: ['CWE-1104', 'CWE-829'] },
]);

// prefix -> reference markdown filename; used ONLY by the build-time re-vendor helper below.
const REFERENCE_FILE_BY_PREFIX = Object.freeze({
  ACX: 'access-control-patterns.md',
  ATX: 'account-takeover-patterns.md',
  AIX: 'ai-agent-patterns.md',
  XX: 'browser-xss-patterns.md',
  CBX: 'cache-boundary-patterns.md',
  CLX: 'cloud-iam-patterns.md',
  CIX: 'command-execution-patterns.md',
  XD: 'cross-cutting-static-differentials.md',
  CRX: 'cryptographic-misuse-patterns.md',
  UPX: 'file-upload-patterns.md',
  MSX: 'memory-safety-patterns.md',
  MBX: 'mobile-client-patterns.md',
  PDX: 'parser-differential-patterns.md',
  PTX: 'path-traversal-patterns.md',
  QIX: 'query-injection-patterns.md',
  QEX: 'queue-event-boundary-patterns.md',
  RIX: 'request-integrity-patterns.md',
  HDS: 'request-smuggling-patterns.md',
  REX: 'resource-exhaustion-patterns.md',
  SDX: 'sensitive-data-exposure-patterns.md',
  BCX: 'smart-contract-patterns.md',
  SX: 'ssrf-patterns.md',
  SMX: 'state-machine-patterns.md',
  SCX: 'supply-chain-patterns.md',
});

// Hand-authored CWE id -> name map for every CWE referenced above.
const CWE_NAMES = Object.freeze({
  'CWE-22': 'Path Traversal',
  'CWE-77': 'Command Injection',
  'CWE-78': 'OS Command Injection',
  'CWE-79': 'Cross-Site Scripting (XSS)',
  'CWE-89': 'SQL Injection',
  'CWE-90': 'LDAP Injection',
  'CWE-119': 'Improper Restriction of Operations within a Memory Buffer',
  'CWE-200': 'Exposure of Sensitive Information to an Unauthorized Actor',
  'CWE-269': 'Improper Privilege Management',
  'CWE-284': 'Improper Access Control',
  'CWE-287': 'Improper Authentication',
  'CWE-307': 'Improper Restriction of Excessive Authentication Attempts',
  'CWE-312': 'Cleartext Storage of Sensitive Information',
  'CWE-326': 'Inadequate Encryption Strength',
  'CWE-327': 'Use of a Broken or Risky Cryptographic Algorithm',
  'CWE-330': 'Use of Insufficiently Random Values',
  'CWE-345': 'Insufficient Verification of Data Authenticity',
  'CWE-352': 'Cross-Site Request Forgery (CSRF)',
  'CWE-359': 'Exposure of Private Personal Information to an Unauthorized Actor',
  'CWE-400': 'Uncontrolled Resource Consumption',
  'CWE-416': 'Use After Free',
  'CWE-434': 'Unrestricted Upload of File with Dangerous Type',
  'CWE-436': 'Interpretation Conflict',
  'CWE-441': 'Unintended Proxy or Intermediary (Confused Deputy)',
  'CWE-444': 'Inconsistent Interpretation of HTTP Requests (Request Smuggling)',
  'CWE-524': 'Use of Cache Containing Sensitive Information',
  'CWE-639': 'Insecure Direct Object Reference (IDOR)',
  'CWE-640': 'Weak Password Recovery Mechanism',
  'CWE-668': 'Exposure of Resource to Wrong Sphere',
  'CWE-682': 'Incorrect Calculation',
  'CWE-732': 'Incorrect Permission Assignment for Critical Resource',
  'CWE-770': 'Allocation of Resources Without Limits or Throttling',
  'CWE-787': 'Out-of-Bounds Write',
  'CWE-829': 'Inclusion of Functionality from Untrusted Control Sphere',
  'CWE-841': 'Improper Enforcement of Behavioral Workflow',
  'CWE-862': 'Missing Authorization',
  'CWE-863': 'Incorrect Authorization',
  'CWE-918': 'Server-Side Request Forgery (SSRF)',
  'CWE-923': 'Improper Restriction of Communication Channel to Intended Endpoints',
  'CWE-943': 'Improper Neutralization of Special Elements in Data Query Logic (NoSQL Injection)',
  'CWE-1104': 'Use of Unmaintained Third-Party Components',
  'CWE-1427': 'Improper Neutralization of Input Used for LLM Prompting',
});

// The six-field canonical card shape (`## <ID> — <title>` card contract).
export const CARD_FIELDS = Object.freeze(['invariant', 'attackerControl', 'differential', 'requiredProof', 'decisiveRejection', 'overlaps']);

// field key -> the exact bold label used in a canonical/custom card's markdown.
const FIELD_LABEL_RE = Object.freeze({
  invariant: /\*\*Invariant\/goal:\*\*/i,
  attackerControl: /\*\*Attacker control:\*\*/i,
  differential: /\*\*Guard-to-sink differential:\*\*/i,
  requiredProof: /\*\*Required proof:\*\*/i,
  decisiveRejection: /\*\*Decisive rejection:\*\*/i,
  overlaps: /\*\*Overlaps:\*\*/i,
});

export function familyByPrefix(prefix) { return FAMILIES.find((f) => f.prefix === prefix) || null; }
export function cwesForFamilies(prefixes) {
  return [...new Set(prefixes.flatMap((p) => (familyByPrefix(p)?.cwe) || []))];
}

// Union of CWEs across all families as [{id, name, families:[prefix]}] — backs the "By CWE" view.
export function cweCatalog() {
  const byId = new Map();
  for (const family of FAMILIES) {
    for (const id of family.cwe) {
      if (!byId.has(id)) byId.set(id, { id, name: CWE_NAMES[id] || id, families: [] });
      byId.get(id).families.push(family.prefix);
    }
  }
  return [...byId.values()];
}

const CARD_HEADER_RE = /^##\s+([A-Z]{2,5}-\d{2})\s+—\s+(.+)$/gm;

// The canonical catalog, VENDORED into this package (data/cards.json). Reads our own data,
// never an external checkout — SecForge ships self-contained. Degrades to [] (never throws).
export function loadCanonicalCards() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'cards.json'), 'utf8')); }
  catch { return []; }
}

// Build-time helper (maintainers only) to re-vendor the catalog from a reference checkout.
// NOT used at runtime; requires an explicit path so no external location is baked into the product.
export function importCanonicalCards(root) {
  if (!root) throw new Error('importCanonicalCards(root): pass an explicit reference path');
  const refDir = join(root, 'vulnerabilities-pattern-skill', 'references');
  if (!existsSync(refDir)) return [];
  const cards = [];
  for (const family of FAMILIES) {
    const file = REFERENCE_FILE_BY_PREFIX[family.prefix];
    const p = file && join(refDir, file);
    if (!p || !existsSync(p)) continue;
    for (const match of readFileSync(p, 'utf8').matchAll(CARD_HEADER_RE)) {
      cards.push({ id: match[1], family: family.prefix, title: match[2].trim() });
    }
  }
  return cards;
}

function validateCardFields(text) {
  const missing = CARD_FIELDS.filter((field) => !FIELD_LABEL_RE[field].test(text));
  return { ok: missing.length === 0, missing };
}

function parseCustomCard(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const header = text.match(/^##?\s+(\S+)\s+—\s+(.+)$/m);
  return {
    id: header ? header[1] : basename(filePath, '.md'),
    title: header ? header[2].trim() : basename(filePath, '.md'),
    file: basename(filePath),
    ...validateCardFields(text),
  };
}

// A custom pattern set imported from a folder (used as-is by consumers that don't validate).
export function customSet(name, cards = []) { return { name, cards, count: cards.length, source: 'custom' }; }

// Read a folder of user-imported `.md` pattern cards and validate each has the 6 canonical fields.
// Pure fs, no execution. Degrades to an empty set when `dir` doesn't exist.
export function loadCustomSet(dir) {
  const name = basename(dir);
  if (!existsSync(dir)) return customSet(name, []);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const cards = files.map((f) => parseCustomCard(join(dir, f)));
  return customSet(name, cards);
}

// Import a folder of custom `.md` pattern cards for the UI's import flow. Pure — reads the
// folder, validates each card's 6 fields, persists nothing. Wraps loadCustomSet.
export function importCustomFolder(dir) {
  const { name, cards } = loadCustomSet(dir);
  return {
    name,
    count: cards.length,
    cards: cards.map((c) => ({ id: c.id, title: c.title, ok: c.ok, missing: c.missing })),
  };
}
