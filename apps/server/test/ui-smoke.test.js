import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// S5-1b: a cheap guard against the fabrication class ever coming back. The live app must never
// ship sample findings/evidence that could be mistaken for a real assessment. These are the
// exact markers QA has grepped for across the rounds; demo.html is the ONLY page allowed to
// carry them (it is the watermarked design mock).
describe('index.html has no fabricated-sample strings', () => {
  const MARKERS = [
    'orders_controller.rb', 'checkout_controller.rb', 'models/user.rb', 'tokens.yml',
    'payments-svc', 'staging.acme.test', 'IDOR in Checkout order lookup',
    'SQL injection in report export', 'Auth bypass on admin refund', 'runtime-confirmed',
    'RLX-04', 'CSX-02', 'Authority verified', 'acme-house-rules', '84% triage',
  ];
  for (const m of MARKERS) {
    test(`does not contain "${m}"`, () => {
      assert.equal(INDEX.includes(m), false, `fabricated marker "${m}" is back in index.html`);
    });
  }
});

describe('tab gate is driven by one source', () => {
  test('setNavGate drives the disabled attribute (not CSS-only)', () => {
    assert.match(INDEX, /function setNavGate\(\)/);
    assert.match(INDEX, /\.disabled\s*=\s*gated/);
  });
});
