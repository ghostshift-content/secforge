// @secforge/patterns — canonical + custom pattern loading, with CWE mapping.
// Phase 3 vendors the 281 StaticCodeReview cards; this skeleton ships the 24 family registry
// and the CWE map so the UI's pattern picker and CWE checklist have a real backing.

// Canonical family registry (prefix → readable name, count, CWE ids it maps to).
export const FAMILIES = Object.freeze([
  { prefix: 'ACX', name: 'Access control', count: 32, cwe: ['CWE-284', 'CWE-639', 'CWE-862', 'CWE-863'] },
  { prefix: 'QIX', name: 'Query injection', count: 17, cwe: ['CWE-89', 'CWE-90'] },
  { prefix: 'CIX', name: 'Command execution', count: 18, cwe: ['CWE-78'] },
  { prefix: 'SX', name: 'SSRF', count: 11, cwe: ['CWE-918'] },
  { prefix: 'XX', name: 'Browser XSS', count: 20, cwe: ['CWE-79'] },
  { prefix: 'PTX', name: 'Path traversal', count: 13, cwe: ['CWE-22'] },
  { prefix: 'SMX', name: 'State machine', count: 14, cwe: ['CWE-841'] },
  { prefix: 'RLX', name: 'Resource limits', count: 9, cwe: ['CWE-770', 'CWE-400'] },
  { prefix: 'CRX', name: 'Cryptography', count: 12, cwe: ['CWE-327', 'CWE-326'] },
]);

// The six-field canonical card shape (StaticCodeReview). Validators land in Phase 3.
export const CARD_FIELDS = Object.freeze(['invariant', 'attackerControl', 'differential', 'requiredProof', 'decisiveRejection', 'overlaps']);

export function familyByPrefix(prefix) { return FAMILIES.find((f) => f.prefix === prefix) || null; }
export function cwesForFamilies(prefixes) {
  return [...new Set(prefixes.flatMap((p) => (familyByPrefix(p)?.cwe) || []))];
}

// A custom pattern set imported from a folder (Phase 3 validates each card).
export function customSet(name, cards = []) { return { name, cards, count: cards.length, source: 'custom' }; }
