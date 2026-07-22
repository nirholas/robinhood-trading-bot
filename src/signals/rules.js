/**
 * Declarative rule engine. A rule is JSON:
 *
 *   {
 *     "name": "fresh-launch",
 *     "enabled": true,
 *     "source": "new_pair",            // which signal stream it applies to
 *     "when": {                         // every condition must hold (AND)
 *       "ageMinutes":     { "lte": 30 },
 *       "liquidityUsd":   { "gte": 20000 },
 *       "devBuyPct":      { "lte": 5 },
 *       "launchpad":      { "eq": "odyssey" }
 *     },
 *     "action": { "side": "buy", "quoteUsd": 25 }
 *   }
 *
 * Comparators: lt, lte, gt, gte, eq, neq, in, exists. Dotted paths reach
 * nested fields ("onchain.holders"). A condition on a missing / null field
 * fails the rule (except `exists: false`), so partial enrichment can never
 * accidentally satisfy a filter.
 */

const COMPARATORS = {
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  exists: (a, b) => (a !== undefined && a !== null) === Boolean(b),
};

export function getPath(object, path) {
  let current = object;
  for (const part of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * @returns {{pass: boolean, failed: string[]}} which conditions failed, for
 *   the dashboard's "why didn't my rule fire" view.
 */
export function evaluateConditions(when, signal) {
  const failed = [];
  for (const [path, condition] of Object.entries(when ?? {})) {
    const value = getPath(signal, path);
    if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
      // Shorthand: "field": literal means eq.
      if (value !== condition) failed.push(`${path} eq ${JSON.stringify(condition)}`);
      continue;
    }
    for (const [op, expected] of Object.entries(condition)) {
      const compare = COMPARATORS[op];
      if (!compare) {
        failed.push(`${path}: unknown comparator "${op}"`);
        continue;
      }
      if (op !== 'exists' && (value === undefined || value === null)) {
        failed.push(`${path} is missing (needed ${op} ${JSON.stringify(expected)})`);
        continue;
      }
      // Numeric comparators on numeric-looking strings compare as numbers.
      const left = normalize(value, expected, op);
      const right = normalize(expected, value, op);
      if (!compare(left, right)) {
        failed.push(`${path} ${op} ${JSON.stringify(expected)} (was ${JSON.stringify(value)})`);
      }
    }
  }
  return { pass: failed.length === 0, failed };
}

function normalize(value, other, op) {
  if (op === 'in' || op === 'exists') return value;
  if (typeof value === 'string' && typeof other === 'number') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return value;
}

/**
 * Find the first enabled rule for this signal source whose conditions all
 * pass. First match wins; order your rules from most to least specific.
 *
 * @param {Array<object>} rules
 * @param {string} source signal stream ('new_pair' | 'new_listing' | 'copy')
 * @param {object} signal enriched signal data
 * @returns {{rule: object, evaluations: Array<{name: string, pass: boolean, failed: string[]}>}}
 */
export function matchRules(rules, source, signal) {
  const evaluations = [];
  let matched = null;
  for (const rule of rules ?? []) {
    if (!rule?.enabled || rule.source !== source) continue;
    const result = evaluateConditions(rule.when, signal);
    evaluations.push({ name: rule.name, pass: result.pass, failed: result.failed });
    if (result.pass && !matched) matched = rule;
  }
  return { rule: matched, evaluations };
}

/** Validate a rules array before saving; returns a list of problems. */
export function validateRules(rules) {
  const problems = [];
  if (!Array.isArray(rules)) return ['entryRules must be an array'];
  rules.forEach((rule, index) => {
    const label = rule?.name || `rule[${index}]`;
    if (!rule || typeof rule !== 'object') {
      problems.push(`${label}: not an object`);
      return;
    }
    if (!rule.name) problems.push(`rule[${index}]: missing "name"`);
    if (!['new_pair', 'copy'].includes(rule.source)) {
      problems.push(`${label}: source must be new_pair or copy`);
    }
    if (rule.when && typeof rule.when === 'object') {
      for (const [path, condition] of Object.entries(rule.when)) {
        if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
          for (const op of Object.keys(condition)) {
            if (!COMPARATORS[op]) problems.push(`${label}: unknown comparator "${op}" on ${path}`);
          }
        }
      }
    }
    const side = rule.action?.side;
    if (side !== 'buy' && side !== 'sell') problems.push(`${label}: action.side must be buy or sell`);
    const quoteUsd = Number(rule.action?.quoteUsd);
    if (side === 'buy' && (!Number.isFinite(quoteUsd) || quoteUsd <= 0)) {
      problems.push(`${label}: action.quoteUsd must be a positive number`);
    }
  });
  return problems;
}
