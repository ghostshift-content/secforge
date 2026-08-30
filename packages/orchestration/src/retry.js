// @secforge/orchestration/retry — one bounded outer retry for a genuinely transient failure
// (e.g. an adapter CLI process racing on startup). Never masks a deterministic failure as a
// success: it just re-runs `fn` up to `retries` more times, then rethrows the last error.
export async function withRetry(fn, { retries = 1, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
