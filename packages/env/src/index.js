// @secforge/env — guarded dynamic-validation entry point. Static-only by default; a target
// must be explicitly registered with authorized:true before any network call is ever made,
// and even then only a single read-only GET, never a write.
//
// Secrets-at-rest (docs/PHASE4-ENV-PROVIDER-DESIGN.md §4): authHeader/extraHeaders are the only
// two fields ever encrypted — everything else in target.json (baseUrl/scope/authorized) stays
// plaintext. Threat model, stated plainly (must appear anywhere this feature is surfaced):
// encryption protects these two fields from disclosure of the data files ALONE (a backup, a
// support bundle, a synced folder) — it does NOT protect against anyone who can already read
// files as the local user running SecForge, root, or a memory dump of the process.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_ROOT } from '@secforge/store';

function envDir(store, projectId) { return path.join(store.projectDir(projectId), 'env'); }
function targetFile(store, projectId) { return path.join(envDir(store, projectId), 'target.json'); }

// --- secrets-at-rest: AES-256-GCM via node:crypto, machine-local key (§4.3) ------------------
const ALGO = 'aes-256-gcm';
// Derived from the SAME data root store uses (SECFORGE_DATA override, else ~/.secforge/projects)
// — NOT a hardcoded homedir path. Default location is unchanged (~/.secforge/keyring), but a
// deployment that relocates its whole data root via SECFORGE_DATA also relocates the keyring,
// instead of every instance silently sharing one key from the real $HOME.
const KEY_DIR = path.join(path.dirname(DATA_ROOT), 'keyring');
const KEY_FILE = path.join(KEY_DIR, 'env.key');

let cachedKey = null;
// Key source: SECFORGE_ENV_KEY (base64, 32 bytes) if set, else a random key generated on first
// use and written to ~/.secforge/keyring/env.key (mode 0600). Lazy — never touches the keyring
// for a target that has no secret to encrypt.
async function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.SECFORGE_ENV_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'base64');
    if (buf.length !== 32) throw new Error('SECFORGE_ENV_KEY must decode to 32 bytes (base64)');
    return (cachedKey = buf);
  }
  try {
    const onDisk = await fs.readFile(KEY_FILE);
    if (onDisk.length === 32) return (cachedKey = onDisk);
  } catch { /* no key yet — generate one below */ }
  const fresh = crypto.randomBytes(32);
  await fs.mkdir(KEY_DIR, { recursive: true });
  await fs.writeFile(KEY_FILE, fresh, { mode: 0o600 });
  return (cachedKey = fresh);
}

// null/undefined/'' → null (nothing to encrypt, matches "null/{} stay as they are").
async function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const key = await getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

// Never throws: a corrupt envelope or a wrong/rotated key degrades to null, the same posture as
// a missing file (§4.2) — a decrypt failure must never crash the read path.
async function decryptSecret(envelope) {
  if (!envelope) return null;
  try {
    const key = await getKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[secforge/env] could not decrypt stored credential (wrong/rotated key or corrupt data):', errMsg(err));
    return null;
  }
}
const errMsg = (err) => String((err && err.message) || err);

// Persist a test-env config. authorized defaults false (STATIC_ONLY) — dynamic validation
// stays off until a human explicitly flips it on for this project. authHeader/extraHeaders are
// encrypted on disk (see header comment); every other field stays plaintext.
export async function registerTarget(store, projectId, { baseUrl, authHeader, extraHeaders, scope, authorized = false }) {
  if (!baseUrl) throw new Error('registerTarget(): baseUrl is required');
  // P1-2: only http/https targets. Reject javascript:, file:, data:, and non-URLs — a bad scheme
  // here becomes a stored-XSS/SSRF vector the moment the value is rendered or fetched.
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error('registerTarget(): baseUrl must be a valid http(s) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('registerTarget(): baseUrl must use http or https');

  const authHeaderVal = authHeader || null;
  const extraHeadersVal = extraHeaders || {};
  const extraHeadersJson = Object.keys(extraHeadersVal).length ? JSON.stringify(extraHeadersVal) : null;

  const onDisk = {
    baseUrl,
    authHeaderEnc: await encryptSecret(authHeaderVal),
    extraHeadersEnc: await encryptSecret(extraHeadersJson),
    scope: scope || [],
    authorized: !!authorized,
    updatedAt: new Date().toISOString(),
  };
  const file = targetFile(store, projectId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(onDisk, null, 2));

  // Callers keep the exact plaintext shape they always got — encryption is internal to the
  // on-disk format only (§4.2/§5: transparent, no caller change required).
  return { baseUrl, authHeader: authHeaderVal, extraHeaders: extraHeadersVal, scope: onDisk.scope, authorized: onDisk.authorized, updatedAt: onDisk.updatedAt };
}

// Decrypt-on-read. Returns the same {baseUrl, authHeader, extraHeaders, scope, authorized,
// updatedAt} shape every caller already used. Legacy compatibility: a target.json written
// before encryption has plaintext authHeader/extraHeaders keys (no *Enc suffix) — read as
// already-decrypted; the next registerTarget() call rewrites the file in the new shape.
export async function getTarget(store, projectId) {
  let raw;
  try { raw = JSON.parse(await fs.readFile(targetFile(store, projectId), 'utf8')); }
  catch { return null; }

  let authHeader = null;
  if ('authHeaderEnc' in raw) authHeader = await decryptSecret(raw.authHeaderEnc);
  else if ('authHeader' in raw) authHeader = raw.authHeader || null;

  let extraHeaders = {};
  if ('extraHeadersEnc' in raw) {
    const json = await decryptSecret(raw.extraHeadersEnc);
    if (json) { try { extraHeaders = JSON.parse(json); } catch { extraHeaders = {}; } }
  } else if ('extraHeaders' in raw) {
    extraHeaders = raw.extraHeaders || {};
  }

  return { baseUrl: raw.baseUrl, authHeader, extraHeaders, scope: raw.scope || [], authorized: !!raw.authorized, updatedAt: raw.updatedAt };
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
