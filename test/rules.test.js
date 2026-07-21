import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditions, matchRules, validateRules, getPath } from '../src/signals/rules.js';

test('comparators evaluate against signal fields', () => {
  const signal = { ageMinutes: 12, liquidityUsd: 25000, symbol: 'SOL-USD', graduated: true };
  assert.equal(evaluateConditions({ ageMinutes: { lte: 30 } }, signal).pass, true);
  assert.equal(evaluateConditions({ ageMinutes: { gt: 30 } }, signal).pass, false);
  assert.equal(evaluateConditions({ liquidityUsd: { gte: 20000, lt: 30000 } }, signal).pass, true);
  assert.equal(evaluateConditions({ symbol: { in: ['SOL-USD', 'BTC-USD'] } }, signal).pass, true);
  assert.equal(evaluateConditions({ symbol: { in: ['BTC-USD'] } }, signal).pass, false);
  assert.equal(evaluateConditions({ graduated: { eq: true } }, signal).pass, true);
});

test('missing fields fail closed except exists:false', () => {
  const signal = { ageMinutes: 5, holdersCount: null };
  assert.equal(evaluateConditions({ holdersCount: { gte: 10 } }, signal).pass, false);
  assert.equal(evaluateConditions({ devBuyPct: { lte: 5 } }, signal).pass, false);
  assert.equal(evaluateConditions({ devBuyPct: { exists: false } }, signal).pass, true);
  assert.equal(evaluateConditions({ ageMinutes: { exists: true } }, signal).pass, true);
});

test('numeric strings compare as numbers', () => {
  assert.equal(evaluateConditions({ price: { gte: 10 } }, { price: '25.5' }).pass, true);
});

test('dotted paths reach nested fields', () => {
  assert.equal(getPath({ onchain: { holders: 42 } }, 'onchain.holders'), 42);
  const result = evaluateConditions({ 'onchain.holders': { gte: 40 } }, { onchain: { holders: 42 } });
  assert.equal(result.pass, true);
});

test('shorthand literal condition means equality', () => {
  assert.equal(evaluateConditions({ source: 'copy' }, { source: 'copy' }).pass, true);
  assert.equal(evaluateConditions({ source: 'copy' }, { source: 'rule' }).pass, false);
});

test('matchRules honors enabled flag, source, and order', () => {
  const rules = [
    { name: 'disabled', enabled: false, source: 'new_pair', when: {}, action: { side: 'buy', quoteUsd: 5 } },
    { name: 'wrong-source', enabled: true, source: 'new_listing', when: {}, action: { side: 'buy', quoteUsd: 5 } },
    { name: 'strict', enabled: true, source: 'new_pair', when: { ageMinutes: { lte: 1 } }, action: { side: 'buy', quoteUsd: 5 } },
    { name: 'loose', enabled: true, source: 'new_pair', when: { ageMinutes: { lte: 60 } }, action: { side: 'buy', quoteUsd: 10 } },
  ];
  const { rule, evaluations } = matchRules(rules, 'new_pair', { ageMinutes: 30 });
  assert.equal(rule.name, 'loose');
  assert.equal(evaluations.length, 2);
  assert.equal(matchRules(rules, 'new_pair', { ageMinutes: 500 }).rule, null);
});

test('validateRules catches structural problems', () => {
  assert.deepEqual(
    validateRules([{ name: 'ok', source: 'new_pair', when: { x: { lte: 1 } }, action: { side: 'buy', quoteUsd: 5 } }]),
    [],
  );
  const problems = validateRules([
    { source: 'bogus', when: { x: { wat: 1 } }, action: { side: 'hold' } },
  ]);
  assert.ok(problems.some((p) => p.includes('missing "name"')));
  assert.ok(problems.some((p) => p.includes('source')));
  assert.ok(problems.some((p) => p.includes('comparator')));
  assert.ok(problems.some((p) => p.includes('action.side')));
});
