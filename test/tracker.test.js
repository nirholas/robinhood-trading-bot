import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTransfers, classifySwaps, needsTxLookup } from '../src/copytrade/tracker.js';
import { ADDRESSES, ROUTER_ADDRESSES } from '../src/chain/hood.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const WETH = ADDRESSES.weth.toLowerCase();
const USDG = ADDRESSES.usdg.toLowerCase();
const ROUTER = [...ROUTER_ADDRESSES][0];

let logIndex = 0;
function transfer(txHash, token, from, to, value) {
  return {
    transactionHash: txHash,
    logIndex: logIndex++,
    address: token,
    args: { from, to, value },
  };
}

test('groupTransfers reduces logs to per-tx per-token wallet deltas', () => {
  const groups = groupTransfers(
    [
      transfer('0xa', WETH, WALLET, OTHER, 5n * 10n ** 17n),
      transfer('0xa', TOKEN, OTHER, WALLET, 1000n * 10n ** 18n),
      transfer('0xb', TOKEN, WALLET, OTHER, 400n * 10n ** 18n),
    ],
    WALLET,
  );
  assert.equal(groups.size, 2);
  assert.equal(groups.get('0xa').get(WETH), -(5n * 10n ** 17n));
  assert.equal(groups.get('0xa').get(TOKEN), 1000n * 10n ** 18n);
  assert.equal(groups.get('0xb').get(TOKEN), -(400n * 10n ** 18n));
});

test('groupTransfers dedupes logs returned by both from- and to-queries', () => {
  const log = transfer('0xc', TOKEN, WALLET, WALLET, 7n);
  const groups = groupTransfers([log, log], WALLET);
  assert.equal(groups.size, 0); // self-transfer nets to zero
});

test('classifies a WETH-funded buy', () => {
  const deltas = new Map([
    [WETH, -(5n * 10n ** 17n)],
    [TOKEN, 1000n * 10n ** 18n],
  ]);
  const swaps = classifySwaps(deltas);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].side, 'buy');
  assert.equal(swaps[0].token, TOKEN);
  assert.equal(swaps[0].quoteWethWei, -(5n * 10n ** 17n));
});

test('classifies a USDG-funded buy and a sell for USDG', () => {
  const buy = classifySwaps(
    new Map([
      [USDG, -250_000_000n],
      [TOKEN, 10n ** 18n],
    ]),
  );
  assert.equal(buy[0].side, 'buy');
  assert.equal(buy[0].quoteUsdgRaw, -250_000_000n);

  const sell = classifySwaps(
    new Map([
      [USDG, 300_000_000n],
      [TOKEN, -(10n ** 18n)],
    ]),
  );
  assert.equal(sell[0].side, 'sell');
  assert.equal(sell[0].quoteUsdgRaw, 300_000_000n);
});

test('native-ETH router buy resolves via tx value; airdrops do not', () => {
  const deltas = new Map([[TOKEN, 500n * 10n ** 18n]]);
  assert.equal(needsTxLookup(deltas), true);

  const viaRouter = classifySwaps(deltas, { to: ROUTER, valueWei: 10n ** 17n });
  assert.equal(viaRouter.length, 1);
  assert.equal(viaRouter[0].side, 'buy');
  assert.equal(viaRouter[0].quoteWethWei, -(10n ** 17n));

  // Same token-in but a plain transfer from an EOA: not a trade.
  assert.equal(classifySwaps(deltas, { to: OTHER, valueWei: 0n }).length, 0);
  assert.equal(classifySwaps(deltas, null).length, 0);
});

test('plain sends and quote-only movements are not swaps', () => {
  // Token out, nothing back: a send.
  assert.equal(classifySwaps(new Map([[TOKEN, -(10n ** 18n)]])).length, 0);
  // WETH wrap/unwrap or stable transfer only: no non-quote token involved.
  assert.equal(classifySwaps(new Map([[WETH, 10n ** 18n]])).length, 0);
  assert.equal(needsTxLookup(new Map([[WETH, 10n ** 18n]])), false);
});

test('multi-token tx yields one swap per traded token', () => {
  const deltas = new Map([
    [WETH, -(10n ** 18n)],
    [TOKEN, 100n * 10n ** 18n],
    [OTHER, 50n * 10n ** 18n], // second token bought in the same tx
  ]);
  const swaps = classifySwaps(deltas);
  assert.equal(swaps.length, 2);
  assert.ok(swaps.every((swap) => swap.side === 'buy'));
});
