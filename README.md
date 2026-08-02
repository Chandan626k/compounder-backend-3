# Compounder DNA Engine — Backend

## Architecture

```
Browser (compounder-dna-engine.html)
│
├── Step 1: Yahoo Finance (via allorigins proxy)
│     └── fetchYahooData() → extractMetrics()
│           Real: MarketCap, PE, ROE, D/E, margins, growth, 52W, FCF
│
├── Step 2: Local Scoring Engine (pure JS, deterministic)
│     └── scoreLocally()
│           Compounder Score  = Moat×0.30 + EQ×0.25 + Mgmt×0.25 + CE×0.20
│           Wealth Score      = CAGR×0.35 + Reinvest×0.25 + TAM×0.25 + Div×0.15
│           Risk Score        = Debt×0.30 + Val×0.25 + Biz×0.25 + Gov×0.20
│           Confidence Score  = Data×0.30 + Promo×0.25 + Analyst×0.25 + Track×0.20
│           Overall DNA       = C×0.35 + W×0.35 + (100-R)×0.15 + CF×0.15
│
└── Step 3: Backend (this repo) — OpenAI key secured here
      └── POST /api/analyze
            Receives: stockName, metrics, scores
            Returns:  Hinglish HTML verdict
            Caches:   6 hours per stock (in-memory)
            Rate limits: 10 req/min per IP

AI RULE: Scores are calculated locally. AI only writes narrative.
```

## Project Structure

```
compounder-backend/
├── api/
│   ├── analyze.js      ← POST /api/analyze  (main endpoint)
│   └── health.js       ← GET /api/health    (status check)
├── lib/
│   ├── cache.js        ← In-memory LRU cache + rate limiter
│   └── validate.js     ← Input validation + sanitisation
├── package.json
├── vercel.json
├── .env.example
├── .gitignore
└── README.md
```

## Deploy to Vercel (5 minutes)

```bash
# 1. Install Vercel CLI
npm install -g vercel

# 2. Clone / copy this folder
cd compounder-backend

# 3. Install dependencies
npm install

# 4. Deploy
vercel

# 5. Set environment variable in Vercel Dashboard
#    Project → Settings → Environment Variables
#    OPENAI_API_KEY = sk-your-key-here
```

Your backend URL will be: `https://your-project.vercel.app`

Paste this URL into the Backend URL field in the frontend.

## API Specification

### POST /api/analyze

**Request:**
```json
{
  "stockName": "Titan Company Ltd",
  "sector": "Consumer Cyclical",
  "industry": "Luxury Goods",
  "horizon": 20,
  "metrics": {
    "peRatio":          { "value": 52.3,  "unit": "x" },
    "roe":              { "value": 28.5,  "unit": "%" },
    "debtToEquity":     { "value": 0.12,  "unit": "x" },
    "netProfitMargin":  { "value": 11.2,  "unit": "%" },
    "revenueGrowthYoY": { "value": 18.4,  "unit": "%" }
  },
  "scores": {
    "compoundScore":   { "total": 78, "verdict": "Strong Moat",      "sub": [...] },
    "wealthScore":     { "total": 72, "verdict": "High Compounder",   "sub": [...] },
    "riskScore":       { "total": 33, "verdict": "Low Risk",          "sub": [...] },
    "confidenceScore": { "total": 74, "verdict": "High Conviction",   "sub": [...] },
    "overallDNA": 73,
    "dnaType": "Strong Compounder"
  }
}
```

**Response (success):**
```json
{
  "success": true,
  "verdict": "<strong>Titan Company</strong> India ka ek...",
  "cached": false,
  "generatedAt": "2025-01-15T10:30:00Z",
  "tokensUsed": 487,
  "requestId": "abc123"
}
```

**Response (error):**
```json
{
  "success": false,
  "error": "Rate limit exceeded. 10 requests per minute allowed.",
  "resetAt": "2025-01-15T10:31:00Z"
}
```

### GET /api/health

```json
{
  "status": "ok",
  "timestamp": "2025-01-15T10:30:00Z",
  "openai": { "configured": true, "model": "gpt-4o-mini" },
  "cache": { "size": 12, "totalHits": 47 },
  "rateLimit": { "limit": 10, "windowSeconds": 60 }
}
```

## Environment Variables

| Variable         | Required | Default       | Description                        |
|------------------|----------|---------------|------------------------------------|
| `OPENAI_API_KEY` | ✅ Yes   | —             | sk-... from platform.openai.com    |
| `OPENAI_MODEL`   | No       | gpt-4o-mini   | Model to use                       |
| `ALLOWED_ORIGIN` | No       | *             | Your frontend domain for CORS      |

## Future Integration Points

| Module               | Endpoint           | Description                              |
|----------------------|--------------------|------------------------------------------|
| Portfolio Monitoring | POST /api/portfolio| Track multiple stocks, P&L, alerts       |
| News Intelligence    | POST /api/news     | Company news + sentiment analysis        |
| Technical Analysis   | POST /api/technical| RSI, MACD, moving averages interpretation|
| Swing Trading        | POST /api/swing    | 5–30 day trade setups                    |
| Momentum Scanner     | POST /api/momentum | 52W breakout + volume surge detection    |
| Future Compounders   | POST /api/scanner  | Screen all NSE stocks by DNA criteria    |

All future endpoints follow the same pattern:
- Frontend calculates locally
- Backend only provides AI narrative
- Same rate limiting + caching layer
- Same auth model (no key in frontend)

## Cost Model (gpt-4o-mini)

| Scenario         | Tokens/call | Cost/call  | Cost/100 calls |
|------------------|-------------|------------|----------------|
| New stock        | ~700        | ~$0.00042  | ~$0.042        |
| Cached stock     | 0           | $0.00      | $0.00          |
| 6h cache TTL     | —           | 90%+ saved | —              |

Typical monthly cost for 1000 unique stock analyses: **~$0.42**
