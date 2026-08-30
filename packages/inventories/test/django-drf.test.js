import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext } from '../src/universal.js';
import { djangoDrfPlugin } from '../src/django-drf.js';

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-drf-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

describe('djangoDrfPlugin.detect', () => {
  test('fires when Django is in the profile frameworks', () => {
    assert.ok(djangoDrfPlugin.detect({ frameworks: ['Django'] }));
    assert.ok(!djangoDrfPlugin.detect({ frameworks: ['Flask'] }));
  });
});

describe('DRF APIView route + permissions', () => {
  const root = tmpTree({
    'app/views.py': [
      'from rest_framework.views import APIView',
      'from rest_framework.permissions import IsAuthenticated',
      '',
      'class ItemDetailView(APIView):',
      '    permission_classes = [IsAuthenticated]',
      '',
      '    def get(self, request, pk):',
      '        return Response({})',
      '',
    ].join('\n'),
    'app/urls.py': [
      'from django.urls import path',
      'from .views import ItemDetailView',
      '',
      'urlpatterns = [',
      "    path('items/<int:pk>/', ItemDetailView.as_view()),",
      ']',
      '',
    ].join('\n'),
  });
  const inv = djangoDrfPlugin.inventory(buildContext(root));

  test('resolves the URLconf path to a GET rest_api row', () => {
    const row = inv.rest_api.find((r) => r.path === '/items/{pk}/');
    assert.ok(row, 'expected /items/{pk}/ in rest_api');
    assert.equal(row.method, 'GET');
    assert.equal(row.api_class, 'ItemDetailView');
  });

  test('captures permission_classes as a tokens_actors row', () => {
    assert.ok(inv.tokens_actors.some((r) => r.entry.includes('permission_classes=[IsAuthenticated]')));
  });
});

describe('DRF ModelViewSet router registration', () => {
  const root = tmpTree({
    'app/views.py': [
      'from rest_framework.viewsets import ModelViewSet',
      '',
      'class ItemViewSet(ModelViewSet):',
      '    queryset = None',
      '',
    ].join('\n'),
    'app/api_urls.py': [
      'from rest_framework.routers import DefaultRouter',
      'from .views import ItemViewSet',
      '',
      'router = DefaultRouter()',
      "router.register('items', ItemViewSet)",
      '',
    ].join('\n'),
  });
  const inv = djangoDrfPlugin.inventory(buildContext(root));

  test('expands the viewset into list + detail REST actions', () => {
    const list = inv.rest_api.find((r) => r.path === '/items/' && r.method === 'GET');
    const retrieve = inv.rest_api.find((r) => r.path === '/items/{pk}/' && r.method === 'GET');
    const destroy = inv.rest_api.find((r) => r.path === '/items/{pk}/' && r.method === 'DELETE');
    assert.ok(list, 'expected list action GET /items/');
    assert.ok(retrieve, 'expected retrieve action GET /items/{pk}/');
    assert.ok(destroy, 'expected destroy action DELETE /items/{pk}/');
  });
});
