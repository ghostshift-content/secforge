// CRX-weak-crypto-primitive (CWE-327): a SYMBOL node flagged weak-crypto (DES/3DES/RC4/ECB only,
// deliberately narrow — bare md5/sha1 are excluded). See detector-expansion design §2.2.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validateCandidate } from '../src/rules.js';

const feature = (id, name) => ({ id, type: 'FEATURE', name, data: {}, claims: [] });
const symbol = (id, name, kind, file, line) => ({ id, type: 'SYMBOL', name, data: { kind }, claims: [{ file, line }] });
const edge = (type, src, dst) => ({ id: `edge:${src}:${type}:${dst}`, type, src, dst });

describe('ruleWeakCrypto() — CRX-weak-crypto-primitive', () => {
  test('vuln: crypto.createCipheriv("des-ede3", ...) → weak-crypto SYMBOL node → fires', () => {
    const graph = {
      nodes: [feature('f:billing', 'billing'), symbol('sym:1', "crypto.createCipheriv('des-ede3', key, iv)", 'weak-crypto', 'billing.js', 10)],
      edges: [edge('DEFINES', 'f:billing', 'sym:1')],
    };
    const cands = analyze(graph, {});
    const c = cands.find((x) => x.rule === 'CRX-weak-crypto-primitive');
    assert.ok(c, 'expected a CRX-weak-crypto-primitive candidate');
    assert.equal(c.family, 'CRX');
    assert.equal(c.cwe, 'CWE-327');
    assert.equal(c.featureId, 'f:billing');
    assert.equal(validateCandidate(c, graph), true);
  });

  test('safe (decisive rejection): a strong primitive (aes-256-gcm) produces no weak-crypto SYMBOL, no finding', () => {
    const graph = {
      nodes: [feature('f:billing', 'billing'), symbol('sym:2', "crypto.createCipheriv('aes-256-gcm', key, iv)", 'source-module', 'billing.js', 10)],
      edges: [edge('DEFINES', 'f:billing', 'sym:2')],
    };
    assert.equal(analyze(graph, {}).some((c) => c.rule === 'CRX-weak-crypto-primitive'), false);
  });
});
