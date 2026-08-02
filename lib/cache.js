/**
 * lib/cache.js
 * ─────────────────────────────────────────────────────────
 * In-memory LRU cache + sliding-window rate limiter
 *
 * NOTE: Vercel Serverless Functions are stateless between cold starts.
 * Cache survives within the same warm instance (~5-30 min).
 * For production scale, replace with Vercel KV or Upstash Redis:
 *
 *   import { kv } from '@vercel/kv';
 *   export async function cacheGet(key) { return kv.get(key); }
 *   export async function cacheSet(key, data) { await kv.set(key, data, { ex: 21600 }); }
 *
 * Rate limiter is also per-instance. For cross-instance rate limiting,
 * use Upstash Redis with INCR + EXPIRE commands.
 * ─────────────────────────────────────────────────────────
 */

/* ── CACHE ── */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours per stock
const CACHE_MAX    = 200;                   // max entries before LRU eviction

const cacheStore = new Map();              // key → { data, expiresAt, createdAt, hits }

export function cacheGet(key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  entry.hits++;
  return entry.data;
}

export function cacheSet(key, data) {
  // LRU eviction: remove oldest entry if at capacity
  if (cacheStore.size >= CACHE_MAX) {
    const oldest = [...cacheStore.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
    if (oldest) cacheStore.delete(oldest[0]);
  }
  cacheStore.set(key, {
    data,
    expiresAt : Date.now() + CACHE_TTL_MS,
    createdAt : new Date().toISOString(),
    hits      : 0,
  });
}

export function cacheStats() {
  const entries = [...cacheStore.values()];
  return {
    size       : cacheStore.size,
    totalHits  : entries.reduce((s, e) => s + e.hits, 0),
    oldestEntry: entries.length
      ? new Date(Math.min(...entries.map(e => e.expiresAt - CACHE_TTL_MS))).toISOString()
      : null,
  };
}

/* ── RATE LIMITER ── */
// Sliding window: max N requests per IP per 60-second window
const RATE_LIMIT     = 10;
const RATE_WINDOW_MS = 60 * 1000;

const rateLimitStore = new Map();   // ip → [timestamp, ...]

export function isRateLimited(ip) {
  const now      = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Filter to only requests within current window
  const requests = (rateLimitStore.get(ip) || []).filter(t => t > windowStart);
  requests.push(now);
  rateLimitStore.set(ip, requests);

  // Periodic cleanup of stale IPs to prevent memory leak
  if (Math.random() < 0.002) {
    for (const [k, v] of rateLimitStore) {
      if (v.every(t => t <= windowStart)) rateLimitStore.delete(k);
    }
  }

  // FIX (Bug 2): resetAt should reflect when the CURRENT window expires,
  // not when the oldest request was made. Use now + RATE_WINDOW_MS so
  // the client knows the earliest they can retry from this moment.
  return {
    limited   : requests.length > RATE_LIMIT,
    remaining : Math.max(0, RATE_LIMIT - requests.length),
    resetAt   : new Date(now + RATE_WINDOW_MS).toISOString(),
    count     : requests.length,
  };
}
