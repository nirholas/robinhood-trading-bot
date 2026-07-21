import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWalletSwaps } from '../src/copytrade/tracker.js';
import { swapNotionalUsd } from '../src/copytrade/mirror.js';

const WALLET = 'TrackedWa11etAddressXXXXXXXXXXXXXXXXXXXXXXX';
const MINT = 'MintOfSomeNewTokenXXXXXXXXXXXXXXXXXXXXXXXXX';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx({ preSol, postSol, preTokens = [], postTokens = [] }) {
  return {
    transaction: { message: { accountKeys: [{ pubkey: WALLET }, { pubkey: 'other' }] } },
    meta: {
      err: null,
      preBalances: [preSol, 0],
      postBalances: [postSol, 0],
      preTokenBalances: preTokens,
      postTokenBalances: postTokens,
    },
  };
}

const tokenBalance = (mint, owner, uiAmount) => ({
  mint,
  owner,
  uiTokenAmount: { uiAmount },
});

test('detects a buy: SOL out, token in', () => {
  const swaps = parseWalletSwaps(
    tx({
      preSol: 10e9,
      postSol: 8.99e9,
      preTokens: [],
      postTokens: [tokenBalance(MINT, WALLET, 50000)],
    }),
    WALLET,
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].side, 'buy');
  assert.equal(swaps[0].mint, MINT);
  assert.equal(swaps[0].tokenDelta, 50000);
  assert.ok(swaps[0].solDelta < -1);
});

test('detects a sell with the fraction sold', () => {
  const swaps = parseWalletSwaps(
    tx({
      preSol: 5e9,
      postSol: 7e9,
      preTokens: [tokenBalance(MINT, WALLET, 100000)],
      postTokens: [tokenBalance(MINT, WALLET, 25000)],
    }),
    WALLET,
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].side, 'sell');
  assert.equal(swaps[0].fractionSold, 0.75);
});

test('detects a USDC-quoted buy', () => {
  const swaps = parseWalletSwaps(
    tx({
      preSol: 1e9,
      postSol: 0.999e9,
      preTokens: [tokenBalance(USDC, WALLET, 500)],
      postTokens: [tokenBalance(USDC, WALLET, 100), tokenBalance(MINT, WALLET, 999)],
    }),
    WALLET,
  );
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0].side, 'buy');
  assert.equal(Math.round(swaps[0].usdcDelta), -400);
});

test('ignores other wallets, transfers, and failed transactions', () => {
  // Plain SOL transfer: no token movement, no swap.
  assert.equal(parseWalletSwaps(tx({ preSol: 5e9, postSol: 4e9 }), WALLET).length, 0);
  // Token movement owned by someone else.
  assert.equal(
    parseWalletSwaps(
      tx({ preSol: 1e9, postSol: 0.9e9, postTokens: [tokenBalance(MINT, 'other', 10)] }),
      WALLET,
    ).length,
    0,
  );
  // Airdrop-like receipt with no quote outflow is not a buy.
  assert.equal(
    parseWalletSwaps(
      tx({ preSol: 1e9, postSol: 1e9, postTokens: [tokenBalance(MINT, WALLET, 10)] }),
      WALLET,
    ).length,
    0,
  );
  // Failed transaction.
  const failed = tx({ preSol: 1e9, postSol: 0.5e9, postTokens: [tokenBalance(MINT, WALLET, 10)] });
  failed.meta.err = { InstructionError: [0, 'Custom'] };
  assert.equal(parseWalletSwaps(failed, WALLET).length, 0);
});

test('notional pricing prefers stable delta then SOL', () => {
  assert.equal(swapNotionalUsd({ usdcDelta: -400, solDelta: 0 }, 150), 400);
  assert.equal(swapNotionalUsd({ usdcDelta: 0, solDelta: -2 }, 150), 300);
  assert.equal(swapNotionalUsd({ usdcDelta: 0, solDelta: -2 }, null), null);
});
