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

// docs/PHASE3-LEARNING-DESIGN.md §8.4 — the Memory/Findings tabs show real counts (accepted,
// rejected, mined, learned) only, never a precision/confidence/accuracy percentage anywhere.
describe('Phase 3 self-learning UI never fabricates a metric', () => {
  test('no % sits next to precision/confidence/accuracy anywhere in index.html', () => {
    assert.doesNotMatch(INDEX, /(precision|confidence|accuracy)[^\n<]{0,40}%/i);
    assert.doesNotMatch(INDEX, /%[^\n<]{0,40}(precision|confidence|accuracy)/i);
  });
});

// Phase E — one-page interactive system graph (docs/phase-e-design.md). Additive to the Map
// panel's existing Graph subtab: overview swimlanes + honesty rings/chips + in-place feature
// drill-down + hand-rolled zoom/pan, vanilla JS + SVG only, no external library.
describe('Phase E: system graph overview + drill-down', () => {
  test('overview model + deterministic packing (no force sim) are present', () => {
    assert.match(INDEX, /function overviewModel\(/);
    assert.match(INDEX, /function packRow\(/);
    assert.match(INDEX, /function bubbleWidth\(/);
  });
  test('overview groups by the real DOMAIN--CONTAINS-->FEATURE / FEATURE--EXPOSES-->ENDPOINT edges', () => {
    assert.match(INDEX, /type==='CONTAINS'/);
    assert.match(INDEX, /outOfType\(f\.id, \['EXPOSES'\]\)/);
  });
  test('ARCH_CLUSTER is rendered as a distinct, always-collapsed-by-default swimlane', () => {
    assert.match(INDEX, /ARCH_CLUSTER/);
    assert.match(INDEX, /garch-chip/);
  });
  test('honesty rings: authenticated-but-not-authorized (red) vs no-authn (amber)', () => {
    assert.match(INDEX, /gbubble-gap/);
    assert.match(INDEX, /gbubble-warn/);
    assert.match(INDEX, /AUTHORIZED_BY','GUARDED_BY'/);
  });
  test('reconciliation is fetched and surfaced as a coverage strip, 0 gaps shows no gap chip', () => {
    assert.match(INDEX, /\/reconciliation'/);
    assert.match(INDEX, /function renderCoverageStrip\(/);
    assert.match(INDEX, /if\(gapN>0\) chips\.push/);
  });
  test('feature drill-down fetches the per-feature context dossier and renders authn\\/authz badges', () => {
    assert.match(INDEX, /enterFeatureDossier = function\(/);
    assert.match(INDEX, /\/features\/'\+encodeURIComponent\(id\)\+'\/context/);
    assert.match(INDEX, /no authn/);
    assert.match(INDEX, /no authz/);
  });
  test('citations render file:line + excerpt, depth footer carries the capped honesty chip', () => {
    assert.match(INDEX, /showCitationFor = function\(/);
    assert.match(INDEX, /no cited excerpt for this node/);
    assert.match(INDEX, /depth walk capped at 300 nodes/);
  });
  test('hand-rolled zoom/pan via viewBox, no charting/graph library', () => {
    assert.match(INDEX, /function wireZoomPan\(/);
    assert.match(INDEX, /function applyZoom\(/);
    assert.match(INDEX, /setAttribute\('viewBox'/);
  });
  test('empty/unmapped project reuses the existing honest empty-state helper', () => {
    assert.match(INDEX, /No graph yet\. Nothing has been mapped for this project\./);
  });
});

// The product is loopback-served and zero-dependency: the Phase E graph must not add any external
// script or charting/graph library (a pre-existing Google Fonts <link> predates this work and is
// out of scope — the rule this guards is "no new library", not "no network request ever").
describe('Phase E adds no external script or graph library', () => {
  test('no <script src=...> pointing at a non-local host', () => {
    assert.doesNotMatch(INDEX, /<script[^>]+src\s*=\s*["']https?:\/\//i);
  });
  test('no known CDN/graph-library name anywhere in the file', () => {
    assert.doesNotMatch(INDEX, /cdnjs\.|cdn\.jsdelivr|unpkg\.com|cytoscape|d3\.js|d3\.min|vis-network/i);
  });
});
