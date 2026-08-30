import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext } from '../src/universal.js';
import { railsPlugin } from '../src/rails.js';

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-rails-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('railsPlugin.detect', () => {
  test('fires on Gemfile + rails framework', () => {
    assert.ok(railsPlugin.detect({ frameworks: ['Rails'], manifests: ['Gemfile'] }));
  });
  test('does not fire on an unrelated stack', () => {
    assert.ok(!railsPlugin.detect({ frameworks: [], manifests: [], languages_by_bytes: [], top_directories: [], entry_points: [] }));
  });
});

describe('routes.rb resources expansion', () => {
  test('expands `resources :a, :b` into one row per resource', () => {
    const root = tmpTree({
      'config/routes.rb': "Rails.application.routes.draw do\n  resources :users, :posts\nend\n",
    });
    const inv = railsPlugin.inventory(buildContext(root));
    const entries = inv.routes_endpoints.map((r) => r.entry);
    assert.ok(entries.includes('resources :users'));
    assert.ok(entries.includes('resources :posts'));
  });
});

describe('Grape pathless verb inside a nested resource block', () => {
  test('resolves `resource :things do; get do` to GET /things', () => {
    const root = tmpTree({
      'lib/api/things_api.rb': [
        'module API',
        '  class ThingsAPI < Grape::API',
        '    resource :things do',
        '      get do',
        '        Thing.all',
        '      end',
        '    end',
        '  end',
        'end',
        '',
      ].join('\n'),
    });
    const inv = railsPlugin.inventory(buildContext(root));
    const row = inv.rest_api.find((r) => r.method === 'GET' && r.path === '/things');
    assert.ok(row, 'expected a GET /things rest_api row');
    assert.equal(row.detail, 'grape');
    assert.equal(row.api_class, 'API::ThingsAPI');
  });
});

describe('controller action body spans (design §7)', () => {
  test('scopes body to the owning def...end, not the whole file', () => {
    const root = tmpTree({
      'app/controllers/things_controller.rb': [
        'class ThingsController < ApplicationController',
        '  def show',
        '    @thing = Thing.find(params[:id])',
        '    authorize @thing',
        '    render json: @thing',
        '  end',
        '',
        '  def download_receipt',
        '    @thing = Thing.find(params[:id])',
        '    send_file @thing.path',
        '  end',
        'end',
        '',
      ].join('\n'),
    });
    const inv = railsPlugin.inventory(buildContext(root));
    const lines = fs.readFileSync(path.join(root, 'app/controllers/things_controller.rb'), 'utf8').split(/\r?\n/);

    const show = inv.routes_endpoints.find((r) => r.entry === 'action show');
    const download = inv.routes_endpoints.find((r) => r.entry === 'action download_receipt');
    assert.ok(show?.body, 'show action should have a bounded body span');
    assert.ok(download?.body, 'download_receipt action should have a bounded body span');

    const showBody = lines.slice(show.body.startLine, show.body.endLine - 1).join('\n');
    const downloadBody = lines.slice(download.body.startLine, download.body.endLine - 1).join('\n');
    assert.ok(showBody.includes('authorize @thing'));
    assert.ok(!downloadBody.includes('authorize'), 'the unguarded action body must not include the sibling\'s authorize call');
  });
});

describe('controller-level before_action/skip_before_action authn (design §7 refinement 1)', () => {
  test('before_action ...authenticate... surfaces as a class-level "authn" row with class/parent recoverable', () => {
    const root = tmpTree({
      'app/controllers/application_controller.rb': [
        'class ApplicationController < ActionController::API',
        '  before_action :authenticate_user!',
        'end',
        '',
      ].join('\n'),
    });
    const inv = railsPlugin.inventory(buildContext(root));
    const row = inv.tokens_actors.find((r) => r.detail === 'authn');
    assert.ok(row, 'expected an "authn" row for the class-level before_action');
    assert.equal(row.controllerClass, 'ApplicationController');
    assert.equal(row.controllerParent, 'ActionController::API');
    // must not ALSO appear as a generic 'auth' duplicate
    assert.equal(inv.tokens_actors.filter((r) => r.entry === 'before_action :authenticate_user!').length, 1);
  });

  test('skip_before_action ...authenticate... is distinguishable from before_action', () => {
    const root = tmpTree({
      'app/controllers/webhooks_controller.rb': [
        'class WebhooksController < ApplicationController',
        '  skip_before_action :authenticate_user!',
        'end',
        '',
      ].join('\n'),
    });
    const inv = railsPlugin.inventory(buildContext(root));
    const row = inv.tokens_actors.find((r) => r.detail === 'skip-authn');
    assert.ok(row, 'expected a "skip-authn" row');
    assert.equal(row.controllerClass, 'WebhooksController');
    assert.equal(row.controllerParent, 'ApplicationController');
    assert.equal(inv.tokens_actors.some((r) => r.detail === 'authn'), false);
  });
});
