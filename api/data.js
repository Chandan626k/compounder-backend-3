/**
 * api/data.js — Vercel Serverless Function
 * Uses yahoo-finance2 npm package — handles Yahoo's crumb/cookie automatically
 * POST /api/data
 * Body: { type: 'summary' | 'chart' | 'news', ticker?, query? }
 */

import yahooFinance from 'yahoo-finance2';
import { isRateLimited } from '../lib/cache.js';

const CACHE     = new Map();
const CACHE_TTL = 30 * 60 * 1000;  // 30 min
const CACHE_MAX = 500;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function send(res, status, body) {
  setCORS(res);
  return res.status(status).json(body);
}

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { CACHE.delete(key); return null; }
  return e.data;
}

function cacheSet(key, data) {
  if (CACHE.size >= CACHE_MAX) {
    const first = CACHE.keys().next().value;
    if (first !== undefined) CACHE.delete(first);
  }
  CACHE.set(key, { data, exp: Date.now() + CACHE_TTL });
}

/* ─── Technical Indicators (pure JS) ─── */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return new Array((closes||[]).length).fill(null);
  const k = 2 / (period + 1);
  const ema = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++)
    ema[i] = closes[i] * k + ema[i-1] * (1-k);
  return ema;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d >= 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-d, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = closes.map((_, i) =>
    ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null);
  const validMACD = [], validIdx = [];
  macdLine.forEach((v, i) => { if (v != null) { validMACD.push(v); validIdx.push(i); } });
  const signalRaw = calcEMA(validMACD, 9);
  const signalLine = new Array(closes.length).fill(null);
  validIdx.forEach((origIdx, j) => { signalLine[origIdx] = signalRaw[j]; });
  return { macdLine, signalLine };
}

function calcSR(closes) {
  const window = closes.slice(-Math.min(60, closes.length));
  if (window.length < 3) return { support: null, resistance: null };
  const sorted = [...window].sort((a,b) => a-b);
  const n = sorted.length;
  return {
    support    : +((sorted[0]+sorted[1]+sorted[2])/3).toFixed(2),
    resistance : +((sorted[n-1]+sorted[n-2]+sorted[n-3])/3).toFixed(2),
  };
}

function calcTrend(closes, ema20, ema50, ema200) {
  const price = closes[closes.length-1];
  const e20 = ema20[ema20.length-1];
  const e50 = ema50[ema50.length-1];
  const e200= ema200[ema200.length-1];
  if (!e20||!e50||!e200) return 'INSUFFICIENT_DATA';
  if (price>e20&&e20>e50&&e50>e200) return 'STRONG_UPTREND';
  if (price>e50&&e50>e200)          return 'UPTREND';
  if (price<e20&&e20<e50&&e50<e200) return 'STRONG_DOWNTREND';
  if (price<e50&&e50<e200)          return 'DOWNTREND';
  if (price>e200)                   return 'RECOVERING';
  return 'SIDEWAYS';
}

function detectVolumeSpike(volumes) {
  if (!volumes||volumes.length<21) return false;
  const recent = volumes[volumes.length-1];
  if (!recent||recent===0) return false;
  const slice = volumes.slice(-21,-1).filter(v=>v!=null&&v>0);
  if (slice.length<10) return false;
  const avg = slice.reduce((s,v)=>s+v,0)/slice.length;
  return avg>0 && recent>avg*1.5;
}

function calcRating(rsi, trend, macd, signal, price, ema50) {
  let bull=0, bear=0;
  if (rsi!=null) {
    if (rsi>55&&rsi<=70) bull++;
    else if (rsi<45&&rsi>=30) bear++;
    else if (rsi>70) bear++;
    else if (rsi<30) bull++;
  }
  if (['STRONG_UPTREND','UPTREND','RECOVERING'].includes(trend)) bull+=2;
  else if (['STRONG_DOWNTREND','DOWNTREND'].includes(trend)) bear+=2;
  if (macd!=null&&signal!=null) { if(macd>signal) bull++; else bear++; }
  if (price!=null&&ema50!=null) { if(price>ema50) bull++; else bear++; }
  const total=bull+bear;
  if (!total) return 'NEUTRAL';
  const ratio=bull/total;
  if (ratio>=0.65) return 'BULLISH';
  if (ratio<=0.35) return 'BEARISH';
  return 'NEUTRAL';
}

function calcSwingSignal(rsi, trend, macd, signal, price, support, resistance, vSpike) {
  const bullish = new Set(['STRONG_UPTREND','UPTREND','RECOVERING']);
  const bearish = new Set(['STRONG_DOWNTREND','DOWNTREND']);
  if (rsi!=null&&rsi>=40&&rsi<=60&&bullish.has(trend)&&macd!=null&&signal!=null&&macd>signal)
    return 'BUY_SETUP';
  if (rsi!=null&&rsi<32&&price!=null&&support!=null&&price>support) return 'OVERSOLD_BOUNCE';
  if (resistance!=null&&price!=null&&price>resistance*0.995&&vSpike&&bullish.has(trend))
    return 'BREAKOUT';
  if (rsi!=null&&rsi>72) return 'OVERBOUGHT_EXIT';
  if (bearish.has(trend)) return 'AVOID';
  return 'NEUTRAL';
}

function buildTechnicals(prices, volumes) {
  const closes = prices.map(p=>p.c);
  const last = closes.length-1;
  const price = closes[last];
  const ema20=calcEMA(closes,20), ema50=calcEMA(closes,50), ema200=calcEMA(closes,200);
  const rsiArr=calcRSI(closes,14);
  const {macdLine,signalLine}=calcMACD(closes);
  const {support,resistance}=calcSR(closes);
  const trend=calcTrend(closes,ema20,ema50,ema200);
  const vSpike=detectVolumeSpike(volumes);
  const rsiVal   =rsiArr[last]    !=null?+rsiArr[last].toFixed(2)   :null;
  const macdVal  =macdLine[last]  !=null?+macdLine[last].toFixed(4) :null;
  const signalVal=signalLine[last]!=null?+signalLine[last].toFixed(4):null;
  const e20v=ema20[last]!=null?+ema20[last].toFixed(2):null;
  const e50v=ema50[last]!=null?+ema50[last].toFixed(2):null;
  const e200v=ema200[last]!=null?+ema200[last].toFixed(2):null;
  return {
    rsi:rsiVal, ema20:e20v, ema50:e50v, ema200:e200v,
    macd:macdVal, signal:signalVal, support, resistance, trend,
    volumeSpike:vSpike,
    rating:calcRating(rsiVal,trend,macdVal,signalVal,price,e50v),
    swingSignal:calcSwingSignal(rsiVal,trend,macdVal,signalVal,price,support,resistance,vSpike),
  };
}

/* ─── Main Handler ─── */
export default async function handler(req, res) {
  if (req.method==='OPTIONS') { setCORS(res); return res.status(204).end(); }
  if (req.method!=='POST') return send(res,405,{error:'POST only'});

  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim()||'unknown';
  const rate = isRateLimited(ip);
  if (rate.limited) return send(res,429,{error:'Rate limit exceeded',resetAt:rate.resetAt});

  let body;
  try { body = typeof req.body==='string'?JSON.parse(req.body):(req.body||{}); }
  catch { return send(res,400,{error:'Invalid JSON'}); }

  const {type,ticker,query}=body;
  if (!type) return send(res,400,{error:'type required: summary|chart|news'});

  const VALID_SYM = /^[A-Z0-9.\-^]{1,20}$/i;

  try {
    /* ── SUMMARY ── */
    if (type==='summary') {
      if (!ticker||!VALID_SYM.test(String(ticker).trim()))
        return send(res,400,{error:`Invalid ticker: ${ticker}`});
      const sym = String(ticker).trim().toUpperCase();
      const key = `summary:${sym}`;
      let result = cacheGet(key);
      if (!result) {
        const modules = ['summaryDetail','defaultKeyStatistics','financialData','assetProfile','price'];
        const raw = await yahooFinance.quoteSummary(sym, { modules });
        if (!raw) throw new Error(`No data for ${sym}`);
        // Normalize to same shape extractMetrics() expects
        result = {
          summaryDetail       : raw.summaryDetail        || {},
          defaultKeyStatistics: raw.defaultKeyStatistics  || {},
          financialData       : raw.financialData         || {},
          assetProfile        : raw.assetProfile          || {},
          price               : raw.price                 || {},
        };
        cacheSet(key, result);
      }
      return send(res,200,{success:true,data:result});
    }

    /* ── CHART ── */
    if (type==='chart') {
      if (!ticker||!VALID_SYM.test(String(ticker).trim()))
        return send(res,400,{error:`Invalid ticker: ${ticker}`});
      const sym = String(ticker).trim().toUpperCase();
      const key = `chart:${sym}`;
      let result = cacheGet(key);
      if (!result) {
        const raw = await yahooFinance.chart(sym, {
          interval: '1d',
          period1 : new Date(Date.now() - 365*24*60*60*1000).toISOString().split('T')[0],
          period2 : new Date().toISOString().split('T')[0],
        });
        const quotes = raw?.quotes || [];
        if (quotes.length < 50) throw new Error(`Insufficient history: ${quotes.length} days`);
        const prices  = quotes.map(q=>({t:new Date(q.date).getTime()/1000,c:q.close})).filter(p=>p.c>0);
        const volumes = quotes.map(q=>q.volume||0);
        const technicals = buildTechnicals(prices,volumes);
        result = { prices: prices.map(({t,c})=>({t,c})), technicals };
        cacheSet(key, result);
      }
      return send(res,200,{success:true,data:result});
    }

    /* ── NEWS ── */
    if (type==='news') {
      if (!query||typeof query!=='string'||query.trim().length===0)
        return send(res,400,{error:'query required'});
      const q   = query.trim();
      const key = `news:${q.toLowerCase().replace(/\s+/g,'_').slice(0,60)}`;
      let result = cacheGet(key);
      if (!result) {
        const raw = await yahooFinance.search(q,{newsCount:8,quotesCount:0});
        const items = raw?.news||[];
        result = items.slice(0,5).map(n=>({
          title      : String(n.title||'').trim(),
          publisher  : String(n.publisher||'').trim(),
          link       : String(n.link||'#').trim(),
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime*1000).toLocaleDateString('en-IN') : '',
        })).filter(n=>n.title.length>0);
        if (!result.length) throw new Error(`No news for "${q}"`);
        cacheSet(key, result);
      }
      return send(res,200,{success:true,data:result});
    }

    return send(res,400,{error:`Unknown type: ${type}`});

  } catch(err) {
    console.error(`[data.js] ${type} "${ticker||query}":`, err.message);
    return send(res,502,{success:false,error:err.message||'Server error'});
  }
}
