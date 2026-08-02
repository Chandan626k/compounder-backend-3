/**
 * api/analyze.js  — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * POST /api/analyze
 *
 * Receives: { stockName, sector, industry, metrics, scores, horizon }
 * Returns:  { success, verdict, cached, generatedAt, tokensUsed }
 *
 * Security model:
 *   • OPENAI_API_KEY lives only in Vercel env vars — never in frontend
 *   • Rate limited per IP: 10 req / 60s
 *   • Input validated before touching OpenAI
 *   • Cache prevents duplicate calls for same stock (6h TTL)
 *   • No user data is logged or stored
 *
 * Fixes applied (DeepSearch):
 *   • Bug 5: Removed duplicate CORS object + res.set() calls
 *            CORS is now handled globally via vercel.json headers
 *   • Replaced all res.status(N).set(CORS) with res.status(N)
 * ─────────────────────────────────────────────────────────────
 */

import OpenAI from 'openai';
import { cacheGet, cacheSet, cacheStats } from '../lib/cache.js';
import { isRateLimited }                  from '../lib/cache.js';
import { validateAnalyzeRequest, safeMetric } from '../lib/validate.js';

/* ── OpenAI client (key from env, never from request) ── */
let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    const key = process.env.OPENAI_API_KEY;
    if (!key || !key.startsWith('sk-')) {
      throw new Error('OPENAI_API_KEY not configured on server');
    }
    openaiClient = new OpenAI({ apiKey: key });
  }
  return openaiClient;
}

/* ── Build OpenAI prompt from validated payload ── */
function buildPrompt(stockName, sector, industry, metrics, scores, horizon = 20) {
  const m  = metrics || {};
  const sm = (key, dec = 1) => safeMetric(m, key, dec);

  // Safe accessors with fallbacks to prevent undefined in prompt
  const cs = scores.compoundScore  || {};
  const ws = scores.wealthScore    || {};
  const rs = scores.riskScore      || {};
  const cf = scores.confidenceScore|| {};
  const sub = (score, i) => score?.sub?.[i]?.score ?? 'N/A';

  return `You are a senior equity research analyst specializing in Indian long-term investing.
Philosophy: Warren Buffett (quality moat, long runway) + Vijay Kedia (SMILE framework, growth at reasonable price).

TASK: Write a concise Hinglish (Hindi + English mix) investment research narrative.
Do NOT invent numbers. Only interpret the data below.
Use HTML tags: <strong>, <br>, <span class="hl-c">, <span class="hl-r">, <span class="hl-w">, <span class="hl-cf">

═══ VERIFIED FINANCIAL DATA (Yahoo Finance) ═══
Company      : ${stockName}
Sector       : ${sector} · ${industry}
Market Cap   : ₹${sm('marketCap', 0)} Cr
Current Price: ₹${sm('currentPrice', 0)}
P/E Ratio    : ${sm('peRatio')}x
P/B Ratio    : ${sm('pbRatio')}x
ROE          : ${sm('roe')}%
Debt/Equity  : ${sm('debtToEquity')}x
Net Margin   : ${sm('netProfitMargin')}%
Rev Growth   : ${sm('revenueGrowthYoY')}% YoY
Earn Growth  : ${sm('earningsGrowthYoY')}% YoY
Div Yield    : ${sm('dividendYield')}%
FCF          : ₹${sm('freeCashFlow', 0)} Cr
52W High     : ₹${sm('week52High', 0)}
52W Low      : ₹${sm('week52Low', 0)}

═══ LOCALLY CALCULATED DNA SCORES ═══
Compounder Score : ${cs.total ?? 'N/A'}/100 — ${cs.verdict ?? ''}
  • Moat Strength      : ${sub(cs, 0)}/100
  • Earnings Quality   : ${sub(cs, 1)}/100
  • Mgmt Excellence    : ${sub(cs, 2)}/100
  • Capital Efficiency : ${sub(cs, 3)}/100

Wealth Score     : ${ws.total ?? 'N/A'}/100 — ${ws.verdict ?? ''}
  • CAGR Potential    : ${sub(ws, 0)}/100
  • Reinvestment Rate : ${sub(ws, 1)}/100
  • TAM Expansion     : ${sub(ws, 2)}/100
  • Dividend Power    : ${sub(ws, 3)}/100

Risk Score       : ${rs.total ?? 'N/A'}/100 — ${rs.verdict ?? ''} (lower = safer)
  • Debt Risk       : ${sub(rs, 0)}/100
  • Valuation Risk  : ${sub(rs, 1)}/100
  • Business Risk   : ${sub(rs, 2)}/100
  • Governance Risk : ${sub(rs, 3)}/100

Confidence Score : ${cf.total ?? 'N/A'}/100 — ${cf.verdict ?? ''}

Overall DNA      : ${scores.overallDNA ?? 'N/A'}/100 — ${scores.dnaType ?? ''}
Investment Horizon: ${horizon} years

═══ WRITE THIS REPORT (4 paragraphs, Hinglish HTML) ═══

Paragraph 1 — Business & Moat:
Quote company name, sector. Describe what makes the business special (pricing power, brand, distribution, switching costs). 2-3 sentences.

Paragraph 2 — Numbers ki baat (quote REAL metrics above):
Mention actual ROE, margins, growth rates. Is valuation justified? Compare PE context. 2-3 sentences.

Paragraph 3 — Risk factors:
What can go wrong? Valuation risk, sector cyclicality, debt concern if any. Be honest. 2 sentences.

Paragraph 4 — Long-term thesis (${horizon}-year horizon):
Why hold for ${horizon} years? What needs to be true for this to be a great investment? 2-3 sentences.

Return ONLY the HTML string. No JSON wrapper. No markdown. Start directly with the content.`;
}

/* ── Cache key: normalize stock name ── */
function makeCacheKey(stockName, horizon) {
  const normalized = stockName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `analyze:${normalized}:${horizon}`;
}

/* ── Main handler ── */
export default async function handler(req, res) {
  const requestId = req.headers['x-request-id']
    || (typeof crypto !== 'undefined' && crypto.randomUUID?.())
    || Date.now().toString();

  /* OPTIONS preflight — vercel.json handles CORS headers globally */
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  /* Method guard */
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  /* Rate limiting */
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.socket?.remoteAddress
          || 'unknown';
  const rate = isRateLimited(ip);

  res.setHeader('X-RateLimit-Limit',     '10');
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  res.setHeader('X-RateLimit-Reset',     rate.resetAt);

  if (rate.limited) {
    return res.status(429).json({
      success : false,
      error   : 'Rate limit exceeded. 10 requests per minute allowed.',
      resetAt : rate.resetAt,
    });
  }

  /* Parse body */
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }

  /* Validate */
  const { valid, errors } = validateAnalyzeRequest(body);
  if (!valid) {
    return res.status(400).json({ success: false, error: 'Validation failed', details: errors });
  }

  const { stockName, sector, industry = '', metrics, scores, horizon = 20 } = body;
  const cacheKey = makeCacheKey(stockName, horizon);

  /* Cache hit */
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] ${cacheKey} | requestId=${requestId}`);
    return res.status(200).json({
      success     : true,
      verdict     : cached.verdict,
      cached      : true,
      cachedAt    : cached.generatedAt,
      generatedAt : cached.generatedAt,
      tokensUsed  : 0,
      requestId,
    });
  }

  /* Call OpenAI */
  let verdict, tokensUsed;
  try {
    const ai     = getOpenAI();
    const prompt = buildPrompt(stockName, sector, industry, metrics, scores, horizon);

    console.log(`[OPENAI] Calling for: ${stockName} | horizon: ${horizon}Y | requestId=${requestId}`);

    const completion = await ai.chat.completions.create({
      model      : process.env.OPENAI_MODEL || 'gpt-4o-mini',
      max_tokens : 700,
      temperature: 0.45,
      messages   : [{ role: 'user', content: prompt }],
    });

    verdict    = completion.choices?.[0]?.message?.content?.trim() || '';
    tokensUsed = completion.usage?.total_tokens || 0;

    console.log(`[OPENAI] Done. tokens=${tokensUsed} | requestId=${requestId}`);

    if (!verdict) throw new Error('OpenAI returned empty response');

  } catch (aiErr) {
    console.error(`[OPENAI ERROR] ${aiErr.message} | requestId=${requestId}`);

    const isKeyErr   = aiErr.message?.includes('API key') || aiErr.status === 401;
    const isQuotaErr = aiErr.status === 429 || aiErr.message?.includes('quota');

    return res.status(502).json({
      success  : false,
      error    : isKeyErr   ? 'OpenAI API key invalid or missing on server'
               : isQuotaErr ? 'OpenAI quota exceeded. Try again later.'
               : `AI service error: ${aiErr.message}`,
      requestId,
    });
  }

  /* Cache the result */
  const generatedAt = new Date().toISOString();
  cacheSet(cacheKey, { verdict, generatedAt });

  return res.status(200).json({
    success    : true,
    verdict,
    cached     : false,
    generatedAt,
    tokensUsed,
    requestId,
    cacheStats : cacheStats(),
  });
}
