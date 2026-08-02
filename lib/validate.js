/**
 * lib/validate.js
 * Validates incoming /api/analyze request body.
 * Frontend sends metrics object — we verify shape before calling OpenAI.
 *
 * Fixes applied (DeepSearch Bug 1):
 *   - Added sub array validation for all score objects
 *   - Each sub entry must have a numeric score property
 */

const REQUIRED_FIELDS = ['stockName', 'sector', 'scores'];
const SCORE_KEYS      = ['compoundScore', 'wealthScore', 'riskScore', 'confidenceScore', 'overallDNA'];
const SUB_MIN_LENGTH  = 1;  // at minimum 1 sub-score required per score object

export function validateAnalyzeRequest(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  // Required top-level fields
  for (const f of REQUIRED_FIELDS) {
    if (!body[f]) errors.push(`Missing required field: ${f}`);
  }

  // stockName sanity check
  if (body.stockName) {
    if (typeof body.stockName !== 'string')  errors.push('stockName must be a string');
    if (body.stockName.length > 100)         errors.push('stockName too long (max 100 chars)');
    if (/[<>{}]/.test(body.stockName))       errors.push('stockName contains invalid characters');
  }

  // Scores shape validation — FIX: now validates sub array exists and is well-formed
  if (body.scores && typeof body.scores === 'object') {
    for (const k of SCORE_KEYS) {
      const v = body.scores[k];

      if (v === undefined) {
        errors.push(`Missing score: ${k}`);
        continue;
      }

      if (k === 'overallDNA') {
        if (typeof v !== 'number' || v < 0 || v > 100) {
          errors.push(`overallDNA must be a number 0–100, got: ${JSON.stringify(v)}`);
        }
        continue;
      }

      // Non-overallDNA score keys must be objects with a numeric total
      if (typeof v !== 'object' || v === null) {
        errors.push(`Invalid score shape for ${k}: expected object`);
        continue;
      }
      if (typeof v.total !== 'number') {
        errors.push(`Score ${k} must have a numeric "total" property`);
      }

      // FIX (Bug 1): validate sub array exists and contains valid entries
      if (!Array.isArray(v.sub) || v.sub.length < SUB_MIN_LENGTH) {
        errors.push(`Score ${k} must have a "sub" array with at least ${SUB_MIN_LENGTH} item(s)`);
      } else {
        for (let i = 0; i < v.sub.length; i++) {
          const entry = v.sub[i];
          if (!entry || typeof entry !== 'object') {
            errors.push(`Score ${k} sub[${i}] must be an object`);
          } else if (typeof entry.score !== 'number') {
            errors.push(`Score ${k} sub[${i}].score must be a number, got: ${typeof entry.score}`);
          }
        }
      }
    }
  }

  // Metrics (optional but if present, validate basic structure)
  if (body.metrics !== undefined && (typeof body.metrics !== 'object' || body.metrics === null)) {
    errors.push('metrics must be an object');
  }

  // horizon (optional)
  if (body.horizon !== undefined) {
    const h = Number(body.horizon);
    if (!Number.isInteger(h) || h < 1 || h > 50) {
      errors.push('horizon must be an integer between 1 and 50');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Safe extraction of metric value for prompt building.
 * Returns formatted string or 'N/A' — never throws.
 */
export function safeMetric(metrics, key, decimals = 1) {
  try {
    const v = metrics?.[key]?.value;
    if (v === null || v === undefined) return 'N/A';
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (isNaN(n)) return String(v);
    return n.toFixed(decimals);
  } catch {
    return 'N/A';
  }
}
