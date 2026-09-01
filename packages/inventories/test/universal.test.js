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

  test('detects a csurf() call as a csrf guard signal', () => {
    const root = tmpTree({
      'src/server.js': "const csrf = require('csurf');\napp.use(csrf());\n",
    });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    assert.ok(inv.tokens_actors.some((r) => r.detail === 'csrf'));
  });

  test('detects express-session/req.session as POSITIVE cookie/session evidence (RIX-csrf design)', () => {
    const root = tmpTree({
      'src/server.js': "const session = require('express-session');\napp.use(session({ secret: 'x' }));\napp.post('/x', (req, res) => { req.session.userId = 1; });\n",
    });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    assert.ok(inv.tokens_actors.some((r) => r.detail === 'session-cookie'));
  });

  test('a bearer-token API with no session usage never surfaces session-cookie evidence', () => {
    const root = tmpTree({
      'src/server.js': "app.post('/x', (req, res) => { jwt.verify(req.headers.authorization); });\n",
    });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    assert.equal(inv.tokens_actors.some((r) => r.detail === 'session-cookie'), false);
  });

  test('detects an unambiguous weak-crypto primitive (DES) but not aes-256-gcm', () => {
    const root = tmpTree({
      'src/weak.js': "crypto.createCipheriv('des-ede3', key, iv);\n",
      'src/strong.js': "crypto.createCipheriv('aes-256-gcm', key, iv);\n",
    });
    const ctx = buildContext(root);
    const inv = universalInventory(ctx);
    assert.ok(inv.services_finders_policies.some((r) => r.file === 'src/weak.js' && r.detail === 'weak-crypto'));
    assert.equal(inv.services_finders_policies.some((r) => r.file === 'src/strong.js' && r.detail === 'weak-crypto'), false);
  });

  test('minified/bundled JS is excluded from extraction', () => {
    const root = tmpTree({ 'public/assets/lib.min.js': "app.get('/x',function(){});" });
    const ctx = buildContext(root);
    assert.ok(ctx.bundled.has('public/assets/lib.min.js'));
    const inv = universalInventory(ctx);
    assert.equal(inv.routes_endpoints.length, 0);
  });
});
