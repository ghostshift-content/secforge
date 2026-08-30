import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext, universalInventory } from '../src/universal.js';

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-universal-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('universalInventory — polyglot fallback', () => {
  test('detects an Express route', () => {
    const root = tmpTree({
      'src/server.js': "const app = express();\napp.get('/users/:id', (req, res) => res.send(req.params.id));\n",
    });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    const row = inv.routes_endpoints.find((r) => r.path === '/users/:id');
    assert.ok(row, 'expected an extracted /users/:id route');
    assert.equal(row.method, 'GET');
  });

  test('detects a FastAPI route decorator', () => {
    const root = tmpTree({
      'app/main.py': "from fastapi import FastAPI\napp = FastAPI()\n\n@app.get(\"/items/{item_id}\")\ndef read_item(item_id: int):\n    return {\"item_id\": item_id}\n",
    });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    const row = inv.routes_endpoints.find((r) => r.path === '/items/{item_id}');
    assert.ok(row, 'expected an extracted /items/{item_id} route');
    assert.equal(row.method, 'GET');
  });

  test('every unclassified code file still gets a source-module anchor row', () => {
    const root = tmpTree({ 'lib/opaque.rb': "puts 'hi'\n" });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    assert.ok(inv.services_finders_policies.some((r) => r.file === 'lib/opaque.rb' && r.detail === 'source-module'));
  });

  test('minified/bundled JS is excluded from extraction', () => {
    const root = tmpTree({ 'public/assets/lib.min.js': "app.get('/x',function(){});" });
    const ctx = buildContext(root);
    assert.ok(ctx.bundled.has('public/assets/lib.min.js'));
    const inv = universalInventory(ctx);
    assert.equal(inv.routes_endpoints.length, 0);
  });
});
