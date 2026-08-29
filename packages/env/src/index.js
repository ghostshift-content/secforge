// @secforge/env — guarded dynamic-validation entry point. Static-only by default; a target
// must be explicitly registered with authorized:true before any network call is ever made,
// and even then only a single read-only GET, never a write.

import { promises as fs } from 'node:fs';
import path from 'node:path';

function envDir(store, projectId) { return path.join(store.projectDir(projectId), 'env'); }
function targetFile(store, projectId) { return path.join(envDir(store, projectId), 'target.json'); }

// Persist a test-env config. authorized defaults false (STATIC_ONLY) — dynamic validation
// stays off until a human explicitly flips it on for this project.
export async function registerTarget(store, projectId, { baseUrl, authHeader, extraHeaders, scope, authorized = false }) {
  if (!baseUrl) throw new Error('registerTarget(): baseUrl is required');
  const target = {
    baseUrl,
    authHeader: authHeader || null,
    extraHeaders: extraHeaders || {},
    scope: scope || [],
    authorized: !!authorized,
    updatedAt: new Date().toISOString(),
  };
  const file = targetFile(store, projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(target, null, 2));
  return target;
}

export async function getTarget(store, projectId) {
  try { return JSON.parse(await fs.readFile(targetFile(store, projectId), 'utf8')); }
  catch { return null; }
}

function findingRoute(finding) {
  // accepts either a bare `route` path, or an ID.endpoint-style `endpoint:METHOD:/path` id.
  if (finding?.route) return finding.route;
  const m = /^endpoint:[A-Z]+:(.+)$/.exec(finding?.endpoint || '');
  return m ? m[1] : null;
}

function inScope(route, scope) {
  if (!scope || scope.length === 0) return true;
  return scope.some((prefix) => route.startsWith(prefix));
}

// The guarded dynamic-validation entry point. Never calls the network unless the target is
// registered AND authorized AND dryRun is explicitly false. Only ever a single read-only GET.
export async function validateFinding(store, projectId, finding, { dryRun = true } = {}) {
  const target = await getTarget(store, projectId);
  if (!target || !target.authorized) {
    return { ran: false, reason: 'not authorized (static-only)' };
  }

  const route = findingRoute(finding);
  if (!route) return { ran: false, reason: 'finding has no route to validate' };
  if (!inScope(route, target.scope)) return { ran: false, reason: 'route out of scope' };

  const url = new URL(route, target.baseUrl).toString();
  if (dryRun) {
    return { ran: false, reason: 'dry-run', wouldGet: url };
  }

  // SSRF guard: refuse the classic pivots (cloud metadata, loopback) unless explicitly allowed.
  const host = new URL(url).hostname.toLowerCase();
  const BLOCKED = new Set(['169.254.169.254', 'metadata.google.internal', 'localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (process.env.SECFORGE_ALLOW_INTERNAL !== '1' && (BLOCKED.has(host) || host.endsWith('.internal'))) {
    return { ran: false, reason: 'blocked host (SSRF guard) — set SECFORGE_ALLOW_INTERNAL=1 to override', host };
  }

  const headers = { ...target.extraHeaders };
  if (target.authHeader) headers.Authorization = target.authHeader;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
    return { ran: true, status: res.status, verdict: res.ok ? 'reachable' : 'not-reachable' };
  } catch (e) {
    return { ran: true, status: 0, verdict: 'error', error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}
