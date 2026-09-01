// #1b closure test: LLM_FAMILIES must be a subset of families with a real deterministic rule —
// a family with no rule can never be corroborated by reproveLlmCandidate(), so inviting the model
// to guess at it is dishonest noise, not a detector. Fails pre-fix (QIX/SX had no rule), passes
// once LLM_FAMILIES == {'ACX'} (or once a real QIX/SX rule lands and is added back).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../src/rules.js';
import { LLM_FAMILIES } from '../src/index.js';

describe('LLM_FAMILIES ⊆ families with a rule', () => {
  test('every LLM-eligible family has at least one deterministic rule in RULES', () => {
    const ruleFamilies = new Set(RULES.map((r) => r.family));
    for (const f of LLM_FAMILIES) {
      assert.ok(ruleFamilies.has(f), `${f} is LLM-eligible but has no rule`);
    }
  });

  test('QIX and SX are not LLM-eligible (no deterministic rule exists for either)', () => {
    assert.equal(LLM_FAMILIES.has('QIX'), false);
    assert.equal(LLM_FAMILIES.has('SX'), false);
  });
});
