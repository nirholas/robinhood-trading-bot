import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Risk } from '../src/risk.js';

const silentBus = { warn() {}, info() {}, error() {}, log() {} };

function makeRisk(configOverrides = {}, store = newStore()) {
  const config = {
    risk: {
      maxOrderUsd: 100,
      maxDailyUsd: 500,
      maxOpenPositions: 2,
      perSymbolCooldownSec: 0,
      minQuoteUsd: 1,
      ...configOverrides.risk,
    },
    exits: configOverrides.exits ?? {},
  };
  return { risk: new Risk(silentBus, store, () => config), store };
}

function newStore() {
  return new Store(join(mkdtempSync(join(tmpdir(), 'rhbot-test-')), 'test.db'));
}

test('checkBuy enforces order and daily caps', () => {
  const { risk, store } = makeRisk();
  assert.equal(risk.checkBuy('SOL-USD', 50).ok, true);
  assert.equal(risk.checkBuy('SOL-USD', 101).ok, false);

  store.insertTrade({ mode: 'paper', side: 'buy', symbol: 'BTC-USD', quoteUsd: 480, source: 'rule', reason: 't', status: 'filled' });
  const gate = risk.checkBuy('SOL-USD', 50);
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /daily cap/);
});

test('checkBuy enforces max open positions but allows adding to held symbol', () => {
  const { risk, store } = makeRisk();
  store.upsertPosition({ symbol: 'BTC-USD', qty: 1, avgCost: 100, openedAt: Date.now(), source: 'rule', highWater: 100 });
  store.upsertPosition({ symbol: 'ETH-USD', qty: 1, avgCost: 100, openedAt: Date.now(), source: 'rule', highWater: 100 });
  assert.equal(risk.checkBuy('SOL-USD', 10).ok, false);
  assert.equal(risk.checkBuy('BTC-USD', 10).ok, true);
});

test('checkBuy enforces per-symbol cooldown and pause', () => {
  const { risk, store } = makeRisk({ risk: { perSymbolCooldownSec: 600 } });
  store.insertTrade({ mode: 'paper', side: 'buy', symbol: 'SOL-USD', quoteUsd: 10, source: 'rule', reason: 't', status: 'filled' });
  assert.match(risk.checkBuy('SOL-USD', 10).reason, /cooldown/);
  assert.equal(risk.checkBuy('ETH-USD', 10).ok, true);

  risk.setPaused(true);
  assert.match(risk.checkBuy('ETH-USD', 10).reason, /paused/);
});

test('exitDecision: stop loss, take profit, trailing, max hold', () => {
  const { risk } = makeRisk();
  const position = { symbol: 'SOL-USD', qty: 1, avg_cost: 100, opened_at: Date.now(), high_water: 130 };

  assert.match(
    risk.exitDecision(position, 84, { stopLossPct: 15 }).reason,
    /stop loss/,
  );
  assert.equal(risk.exitDecision(position, 90, { stopLossPct: 15 }), null);
  assert.match(risk.exitDecision(position, 141, { takeProfitPct: 40 }).reason, /take profit/);
  assert.match(risk.exitDecision(position, 115, { trailingStopPct: 10 }).reason, /trailing/);
  assert.equal(risk.exitDecision(position, 125, { trailingStopPct: 10 }), null);

  const oldPosition = { ...position, opened_at: Date.now() - 61 * 60_000 };
  assert.match(risk.exitDecision(oldPosition, 100, { maxHoldMinutes: 60 }).reason, /max hold/);
  assert.equal(risk.exitDecision(position, 100, {}), null);
});

test('store position lifecycle roundtrip', () => {
  const store = newStore();
  store.upsertPosition({ symbol: 'SOL-USD', qty: 2, avgCost: 150, openedAt: 1, source: 'copy', highWater: 150 });
  assert.equal(store.getPosition('SOL-USD').qty, 2);
  store.updateHighWater('SOL-USD', 180);
  assert.equal(store.getPosition('SOL-USD').high_water, 180);
  store.removePosition('SOL-USD');
  assert.equal(store.getPosition('SOL-USD'), null);
});

test('store wallet cursor + kv roundtrip', () => {
  const store = newStore();
  store.addWallet('WalletAddrXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'alpha');
  store.setWalletCursor('WalletAddrXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', 'sig123');
  assert.equal(store.listWallets()[0].last_sig, 'sig123');
  store.kvSetJson('pairs', ['BTC-USD']);
  assert.deepEqual(store.kvGetJson('pairs'), ['BTC-USD']);
});
