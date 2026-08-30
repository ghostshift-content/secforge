import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSourceFile, isCodeFile, profileRepo } from '../src/profiler.js';

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-profiler-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('isSourceFile / isCodeFile', () => {
  test('recognizes source files by name and extension', () => {
    assert.ok(isSourceFile('Gemfile'));
    assert.ok(isSourceFile('app.rb'));
    assert.ok(isSourceFile('.env.production'));
    assert.ok(!isSourceFile('logo.png'));
  });

  test('isCodeFile excludes config/data kinds', () => {
    assert.ok(isCodeFile('app.rb'));
    assert.ok(isCodeFile('index.ts'));
    assert.ok(!isCodeFile('config.yml'));
    assert.ok(!isCodeFile('package.json'));
  });
});

describe('profileRepo', () => {
  test('detects Rails from a Gemfile manifest', () => {
    const root = tmpTree({
      'Gemfile': "gem 'rails'\n",
      'config/routes.rb': "Rails.application.routes.draw do\nend\n",
      'app/controllers/things_controller.rb': "class ThingsController\nend\n",
    });
    const profile = profileRepo(root);
    assert.ok(profile.frameworks.includes('Rails'));
    assert.ok(profile.languages.includes('Ruby'));
    assert.ok(profile.manifests.includes('Gemfile'));
    assert.equal(profile.files, 3);
  });

  test('infers Rails from layout when no Gemfile is present', () => {
    const root = tmpTree({
      'config/routes.rb': "Rails.application.routes.draw do\nend\n",
      'app/controllers/things_controller.rb': "class ThingsController\nend\n",
    });
    const profile = profileRepo(root);
    assert.ok(profile.frameworks.includes('Rails'));
  });
});
