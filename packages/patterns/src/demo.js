// node:assert self-check — run with `node packages/patterns/src/demo.js`.
import assert from 'node:assert/strict';
import { FAMILIES, CARD_FIELDS, familyByPrefix, cwesForFamilies, customSet, loadCanonicalCards, loadCustomSet, cweCatalog } from './index.js';

assert.equal(FAMILIES.length, 24, 'expected 24 canonical families');
assert.ok(FAMILIES.every((f) => f.prefix && f.name && f.count > 0 && Array.isArray(f.cwe) && f.cwe.length > 0));
assert.equal(CARD_FIELDS.length, 6);

assert.deepEqual(familyByPrefix('ACX')?.prefix, 'ACX');
assert.equal(familyByPrefix('NOPE'), null);

const acxCwes = cwesForFamilies(['ACX']);
assert.ok(Array.isArray(acxCwes) && acxCwes.length > 0, 'cwesForFamilies(ACX) should be non-empty');

const canonicalCards = loadCanonicalCards(); // vendored catalog — self-contained, no external checkout
assert.ok(Array.isArray(canonicalCards) && canonicalCards.length > 0, 'vendored catalog must load');
assert.ok(canonicalCards.every((c) => c.id && c.family && c.title), 'every card has id/family/title');

const empty = customSet('empty-set');
assert.equal(empty.count, 0);

const missingCustom = loadCustomSet('/definitely/not/a/real/custom/dir');
assert.equal(missingCustom.count, 0, 'missing custom dir must degrade to an empty set');

const catalog = cweCatalog();
assert.ok(Array.isArray(catalog) && catalog.length > 0, 'cweCatalog must be non-empty');
assert.ok(catalog.every((c) => c.id && c.name && Array.isArray(c.families) && c.families.length > 0));

console.log(`OK: ${FAMILIES.length} families, ${canonicalCards.length} canonical cards, ${catalog.length} CWEs`);
