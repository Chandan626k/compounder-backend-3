/**
 * api/health.js
 * GET /api/health
 * Returns server status, OpenAI key presence (NOT the key itself), cache stats.
 */

import { cacheStats } from '../lib/cache.js';

export default function handler(req, res) {
  const hasKey    = !!(process.env.OPENAI_API_KEY?.startsWith('sk-'));
  const model     = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

  res.status(200).json({
    status    : 'ok',
    timestamp : new Date().toISOString(),
    version   : '1.0.0',
    openai    : {
      configured : hasKey,
      model,
      keyPrefix  : hasKey ? process.env.OPENAI_API_KEY.slice(0, 7) + '...' : null,
    },
    cache     : cacheStats(),
    cors      : { allowedOrigin },
    rateLimit : { limit: 10, windowSeconds: 60 },
  });
}
