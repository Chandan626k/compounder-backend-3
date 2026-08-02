/**
 * api/data.js — Vercel Serverless Function (Node.js runtime)
 * POST /api/data
 * Body: { type: 'summary' | 'chart' | 'news', ticker?, query? }
 *
 * Responses:
 *   type=summary → Yahoo quoteSummary (fundamentals)
 *   type=chart   → { prices[], technicals{} }
 *   type=news    → headlines[]
 */

import { isRateLimited } from '../lib/cache.js';

/* ─── Constants ─────────────────────────────────────────────── */

const CACHE_TTL    = 30 * 60 * 1000;   // 30 minutes
const CACHE_MAX    = 500;
const FETCH_TIMEOUT= 10_000;           // 10 seconds
const MIN_HISTORY  = 50;               // minimum candles required

const CACHE = new Map();

const YAHOO_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer'        : 'https://finance.yahoo.com/',
  'Origin'         : 'https://finance.yahoo.com',
};

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const VALID_SYMBOL   = /^[A-Z0-9.\-^]{1,20}$/i;

/* ─── CORS helper ────────────────────────────────────────────── */

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  return res;
}

function send(res, status, body) {
  setCORS(res);
  return res.status(status).json(body);
}

/* ─── In-memory LRU cache ────────────────────────────────────── */

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { CACHE.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  if (CACHE.size >= CACHE_MAX) {
    // evict oldest entry
    const firstKey = CACHE.keys().next().value;
    if (firstKey !== undefined) CACHE.delete(firstKey);
  }
  CACHE.set(key, { data, exp: Date.now() + CACHE_TTL });
}

/* ─── Yahoo Finance fetch (server-side, no CORS block) ───────── */

async function yahooFetch(url) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      headers : YAHOO_HEADERS,
      signal  : controller.signal,
      redirect: 'follow',
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Yahoo HTTP ${resp.status}: ${text.slice(0, 120)}`);
    }
    const json = await resp.json();
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Yahoo Finance timeout after 10s');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Technical Indicator Engine (pure JS, no external libs) ─── */

/**
 * EMA — Exponential Moving Average
 * Returns array of same length as closes; null for positions before period seeds.
 */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return new Array((closes || []).length).fill(null);
  const k   = 2 / (period + 1);
  const ema = new Array(closes.length).fill(null);
  let sum   = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/**
 * RSI(14) — Wilder's smoothed RSI
 * Returns array of same length as closes; null before seed period.
 */
function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else           avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    rsi[i]  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

/**
 * MACD — index-aligned implementation
 * Returns { macdLine[], signalLine[] } — both same length as closes.
 */
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);

  // Build MACD line — null where either EMA is null
  const macdLine = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null
  );

  // Signal line: EMA(9) of macdLine values only, then re-map back to index
  // Collect valid values with their original indices
  const validMACD  = [];
  const validIdx   = [];
  macdLine.forEach((v, i) => { if (v != null) { validMACD.push(v); validIdx.push(i); } });

  const signalRaw  = calcEMA(validMACD, 9);
  const signalLine = new Array(closes.length).fill(null);
  validIdx.forEach((origIdx, j) => { signalLine[origIdx] = signalRaw[j]; });

  return { macdLine, signalLine };
}

/**
 * Support & Resistance — based on recent 60-candle swing lows/highs
 */
function calcSupportResistance(closes) {
  const window = closes.slice(-Math.min(60, closes.length));
  if (window.length < 3) return { support: null, resistance: null };
  const sorted = [...window].sort((a, b) => a - b);
  const n      = sorted.length;
  const support    = (sorted[0] + sorted[1] + sorted[2]) / 3;
  const resistance = (sorted[n-1] + sorted[n-2] + sorted[n-3]) / 3;
  return {
    support    : +support.toFixed(2),
    resistance : +resistance.toFixed(2),
  };
}

/**
 * Trend Strength — 6-state classification
 */
function calcTrend(closes, ema20, ema50, ema200) {
  const price = closes[closes.length - 1];
  const e20   = ema20[ema20.length - 1];
  const e50   = ema50[ema50.length - 1];
  const e200  = ema200[ema200.length - 1];

  if (e20 == null || e50 == null || e200 == null) return 'INSUFFICIENT_DATA';
  if (price > e20 && e20 > e50 && e50 > e200) return 'STRONG_UPTREND';
  if (price > e50 && e50 > e200)               return 'UPTREND';
  if (price < e20 && e20 < e50 && e50 < e200) return 'STRONG_DOWNTREND';
  if (price < e50 && e50 < e200)               return 'DOWNTREND';
  if (price > e200)                            return 'RECOVERING';
  return 'SIDEWAYS';
}

/**
 * Volume Spike — current volume > 1.5× 20-day average
 */
function detectVolumeSpike(volumes) {
  if (!volumes || volumes.length < 21) return false;
  const recent = volumes[volumes.length - 1];
  if (recent == null || recent === 0) return false;
  const slice  = volumes.slice(-21, -1).filter(v => v != null && v > 0);
  if (slice.length < 10) return false;
  const avg20  = slice.reduce((s, v) => s + v, 0) / slice.length;
  return avg20 > 0 && recent > avg20 * 1.5;
}

/**
 * Technical Rating — composite Bullish / Neutral / Bearish
 */
function calcRating(rsi, trend, macd, signal, price, ema50) {
  let bullSignals = 0, bearSignals = 0;

  // RSI
  if (rsi != null) {
    if (rsi > 55 && rsi <= 70) bullSignals++;
    else if (rsi < 45 && rsi >= 30) bearSignals++;
    else if (rsi > 70) bearSignals++;   // overbought
    else if (rsi < 30) bullSignals++;   // oversold bounce
  }

  // Trend
  if (trend === 'STRONG_UPTREND' || trend === 'UPTREND' || trend === 'RECOVERING') bullSignals += 2;
  else if (trend === 'STRONG_DOWNTREND' || trend === 'DOWNTREND') bearSignals += 2;

  // MACD crossover
  if (macd != null && signal != null) {
    if (macd > signal) bullSignals++;
    else               bearSignals++;
  }

  // Price vs EMA50
  if (price != null && ema50 != null) {
    if (price > ema50) bullSignals++;
    else               bearSignals++;
  }

  const total = bullSignals + bearSignals;
  if (total === 0) return 'NEUTRAL';
  const ratio = bullSignals / total;
  if (ratio >= 0.65) return 'BULLISH';
  if (ratio <= 0.35) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Swing Signal — entry quality for 5–20 day trades
 */
function calcSwingSignal(rsi, trend, macd, signal, price, support, resistance, volumeSpike) {
  const bullishTrends = new Set(['STRONG_UPTREND', 'UPTREND', 'RECOVERING']);
  const bearishTrends = new Set(['STRONG_DOWNTREND', 'DOWNTREND']);

  // Strong buy setup
  if (
    rsi != null && rsi >= 40 && rsi <= 60 &&
    bullishTrends.has(trend) &&
    macd != null && signal != null && macd > signal
  ) return 'BUY_SETUP';

  // Oversold bounce
  if (rsi != null && rsi < 32 && price != null && support != null && price > support)
    return 'OVERSOLD_BOUNCE';

  // Breakout with volume
  if (
    resistance != null && price != null &&
    price > resistance * 0.995 &&
    volumeSpike &&
    bullishTrends.has(trend)
  ) return 'BREAKOUT';

  // Overbought — exit / avoid
  if (rsi != null && rsi > 72) return 'OVERBOUGHT_EXIT';

  // Downtrend — avoid
  if (bearishTrends.has(trend)) return 'AVOID';

  return 'NEUTRAL';
}

/**
 * Master technicals builder — called once per chart request
 */
function buildTechnicals(prices, volumes) {
  const closes = prices.map(p => p.c);
  const last   = closes.length - 1;
  const price  = closes[last];

  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const rsiArr = calcRSI(closes, 14);
  const { macdLine, signalLine } = calcMACD(closes);
  const { support, resistance }  = calcSupportResistance(closes);
  const trend  = calcTrend(closes, ema20, ema50, ema200);
  const volSpike = detectVolumeSpike(volumes);

  const rsiVal    = rsiArr[last]    != null ? +rsiArr[last].toFixed(2)    : null;
  const macdVal   = macdLine[last]  != null ? +macdLine[last].toFixed(4)  : null;
  const signalVal = signalLine[last]!= null ? +signalLine[last].toFixed(4): null;
  const ema20Val  = ema20[last]     != null ? +ema20[last].toFixed(2)     : null;
  const ema50Val  = ema50[last]     != null ? +ema50[last].toFixed(2)     : null;
  const ema200Val = ema200[last]    != null ? +ema200[last].toFixed(2)    : null;

  const rating      = calcRating(rsiVal, trend, macdVal, signalVal, price, ema50Val);
  const swingSignal = calcSwingSignal(rsiVal, trend, macdVal, signalVal, price, support, resistance, volSpike);

  return {
    rsi        : rsiVal,
    ema20      : ema20Val,
    ema50      : ema50Val,
    ema200     : ema200Val,
    macd       : macdVal,
    signal     : signalVal,
    support,
    resistance,
    trend,
    volumeSpike: volSpike,
    rating,
    swingSignal,
  };
}

/* ─── Main Vercel handler ────────────────────────────────────── */

export default async function handler(req, res) {

  // Preflight
  if (req.method === 'OPTIONS') {
    setCORS(res);
    return res.status(204).end();
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed. Use POST.' });

  // Rate limiting
  const ip   = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const rate = isRateLimited(ip);
  if (rate.limited) return send(res, 429, { error: 'Rate limit exceeded. 10 requests per minute allowed.', resetAt: rate.resetAt });

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return send(res, 400, { error: 'Invalid JSON body' });
  }

  const { type, ticker, query } = body;

  if (!type || typeof type !== 'string') return send(res, 400, { error: 'Field "type" required: summary | chart | news' });

  try {

    /* ── SUMMARY ── */
    if (type === 'summary') {
      if (!ticker || !VALID_SYMBOL.test(String(ticker).trim()))
        return send(res, 400, { error: `Invalid or missing ticker: "${ticker}"` });

      const sym      = String(ticker).trim().toUpperCase();
      const cacheKey = `summary:${sym}`;
      let   result   = cacheGet(cacheKey);

      if (!result) {
        const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price';
        const raw     = await yahooFetch(
          `https://query1.finance.yahoo.com/v11/finance/quoteSummary/${sym}?modules=${modules}&crumb=`
        );
        const yahooErr = raw?.quoteSummary?.error;
        if (yahooErr) throw new Error(yahooErr.description || JSON.stringify(yahooErr));
        result = raw?.quoteSummary?.result?.[0];
        if (!result) throw new Error(`No fundamental data returned for "${sym}"`);
        cacheSet(cacheKey, result);
      }

      return send(res, 200, { success: true, data: result });
    }

    /* ── CHART + TECHNICALS ── */
    if (type === 'chart') {
      if (!ticker || !VALID_SYMBOL.test(String(ticker).trim()))
        return send(res, 400, { error: `Invalid or missing ticker: "${ticker}"` });

      const sym      = String(ticker).trim().toUpperCase();
      const cacheKey = `chart:${sym}`;
      let   result   = cacheGet(cacheKey);

      if (!result) {
        const raw   = await yahooFetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1y`
        );
        const chunk = raw?.chart?.result?.[0];
        if (!chunk) throw new Error(`No chart data returned for "${sym}"`);

        const timestamps = chunk.timestamp                              || [];
        const quote      = chunk.indicators?.quote?.[0]               || {};
        const rawCloses  = quote.close                                 || [];
        const rawVolumes = quote.volume                                || [];

        const prices = timestamps
          .map((t, i) => ({
            t : t,
            c : rawCloses[i],
            v : rawVolumes[i] ?? 0,
          }))
          .filter(p => p.c != null && p.c > 0 && Number.isFinite(p.c));

        if (prices.length < MIN_HISTORY)
          throw new Error(`Insufficient price history: ${prices.length} days (need ${MIN_HISTORY}+)`);

        const volumes    = prices.map(p => p.v);
        const technicals = buildTechnicals(prices, volumes);

        // Strip volume from price array before sending (reduces payload)
        const pricesSend = prices.map(({ t, c }) => ({ t, c }));

        result = { prices: pricesSend, technicals };
        cacheSet(cacheKey, result);
      }

      return send(res, 200, { success: true, data: result });
    }

    /* ── NEWS ── */
    if (type === 'news') {
      if (!query || typeof query !== 'string' || query.trim().length === 0 || query.length > 120)
        return send(res, 400, { error: 'Invalid or missing "query" field (max 120 chars)' });

      const q        = query.trim();
      const cacheKey = `news:${q.toLowerCase().replace(/\s+/g, '_').slice(0, 80)}`;
      let   result   = cacheGet(cacheKey);

      if (!result) {
        const raw   = await yahooFetch(
          `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=8&quotesCount=0&enableFuzzyQuery=false`
        );
        const items = Array.isArray(raw?.news) ? raw.news : [];
        result = items.slice(0, 5).map(n => ({
          title      : String(n.title       || '').trim(),
          publisher  : String(n.publisher   || '').trim(),
          link       : String(n.link        || '#').trim(),
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime * 1000).toLocaleDateString('en-IN')
            : '',
        })).filter(n => n.title.length > 0);

        if (result.length === 0) throw new Error(`No news found for "${q}"`);
        cacheSet(cacheKey, result);
      }

      return send(res, 200, { success: true, data: result });
    }

    /* ── Unknown type ── */
    return send(res, 400, { error: `Unknown type: "${type}". Use summary | chart | news` });

  } catch (err) {
    const isTimeout = err.message?.includes('timeout') || err.name === 'AbortError';
    console.error(`[data.js] ${type} error for "${ticker || query}":`, err.message);
    return send(res, 502, {
      success: false,
      error  : isTimeout
        ? 'Yahoo Finance request timed out after 10s. Retry karo.'
        : err.message || 'Unexpected server error',
    });
  }
}
