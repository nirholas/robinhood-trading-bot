/**
 * Solana wallet tracker: polls each tracked wallet's transaction history and
 * extracts swaps (what they bought or sold, how much, against what).
 *
 * Parsing is DEX-agnostic: instead of decoding every AMM's instruction
 * layout, it diffs the wallet's pre/post token balances and lamports in each
 * confirmed transaction. A swap is "token in, quote out" or the reverse, no
 * matter which router produced it. That means Jupiter, Raydium, pump.fun,
 * Orca, and whatever launches next week all parse the same way.
 */

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);
const RPC_TIMEOUT_MS = 15_000;
const SIGNATURES_PER_POLL = 25;
/** Wallet-poll transactions older than this are stale, not actionable. */
const MAX_TRADE_AGE_MS = 15 * 60 * 1000;

export class WalletTracker {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {string} rpcUrl
   * @param {(wallet: object, swap: object) => Promise<void>} onSwap
   */
  constructor(bus, store, rpcUrl, onSwap) {
    this.bus = bus;
    this.store = store;
    this.rpcUrl = rpcUrl;
    this.onSwap = onSwap;
  }

  /** One pass over every enabled wallet. */
  async pollAll() {
    const wallets = this.store.listWallets(true);
    for (const wallet of wallets) {
      try {
        await this.pollWallet(wallet);
      } catch (error) {
        this.bus.warn('copy.poll', `Poll failed for ${short(wallet.address)}: ${error.message}`);
      }
    }
  }

  async pollWallet(wallet) {
    const params = [
      wallet.address,
      { limit: SIGNATURES_PER_POLL, ...(wallet.last_sig ? { until: wallet.last_sig } : {}) },
    ];
    const signatures = (await this.rpc('getSignaturesForAddress', params)) ?? [];
    if (!signatures.length) return;

    // Newest first from the RPC. Advance the cursor immediately so a crash
    // mid-batch never replays trades, then process oldest to newest.
    const newest = signatures[0].signature;

    if (!wallet.last_sig) {
      // First poll for this wallet: seed the cursor only. Replaying history
      // would mirror trades the wallet made before we started tracking it.
      this.store.setWalletCursor(wallet.address, newest);
      this.bus.info('copy.seed', `Tracking ${wallet.label || short(wallet.address)} from now on.`);
      return;
    }

    this.store.setWalletCursor(wallet.address, newest);

    const fresh = signatures
      .filter((entry) => !entry.err)
      .filter((entry) => !entry.blockTime || Date.now() - entry.blockTime * 1000 < MAX_TRADE_AGE_MS)
      .reverse();

    for (const entry of fresh) {
      const tx = await this.rpc('getTransaction', [
        entry.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]).catch(() => null);
      if (!tx) continue;
      const swaps = parseWalletSwaps(tx, wallet.address);
      for (const swap of swaps) {
        await this.onSwap(wallet, { ...swap, signature: entry.signature, blockTime: entry.blockTime });
      }
    }
  }

  async rpc(method, params) {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`RPC ${method} ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result;
  }
}

/**
 * Extract the wallet's swaps from a jsonParsed transaction by balance diff.
 * Pure function, unit-tested without a network.
 *
 * @returns {Array<{
 *   mint: string, side: 'buy'|'sell', tokenDelta: number,
 *   preTokenAmount: number, solDelta: number, usdcDelta: number,
 *   fractionSold: number|null
 * }>}
 */
export function parseWalletSwaps(tx, walletAddress) {
  const meta = tx?.meta;
  if (!meta || meta.err) return [];

  // Lamport delta for the wallet itself (fees included; small enough not to
  // distort classification).
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const walletIndex = accountKeys.findIndex(
    (key) => (typeof key === 'string' ? key : key?.pubkey) === walletAddress,
  );
  let solDelta = 0;
  if (walletIndex >= 0 && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    solDelta = (meta.postBalances[walletIndex] - meta.preBalances[walletIndex]) / 1e9;
  }

  // Per-mint token deltas owned by the wallet (wrapped SOL folds into SOL).
  const deltas = new Map();
  const preAmounts = new Map();
  for (const balance of meta.preTokenBalances ?? []) {
    if (balance.owner !== walletAddress) continue;
    const amount = Number(balance.uiTokenAmount?.uiAmount ?? 0);
    preAmounts.set(balance.mint, (preAmounts.get(balance.mint) ?? 0) + amount);
    deltas.set(balance.mint, (deltas.get(balance.mint) ?? 0) - amount);
  }
  for (const balance of meta.postTokenBalances ?? []) {
    if (balance.owner !== walletAddress) continue;
    const amount = Number(balance.uiTokenAmount?.uiAmount ?? 0);
    deltas.set(balance.mint, (deltas.get(balance.mint) ?? 0) + amount);
  }

  const wsolDelta = deltas.get(WSOL_MINT) ?? 0;
  const usdcDelta = (deltas.get(USDC_MINT) ?? 0) + (deltas.get(USDT_MINT) ?? 0);
  const effectiveSolDelta = solDelta + wsolDelta;

  const swaps = [];
  for (const [mint, delta] of deltas) {
    if (QUOTE_MINTS.has(mint)) continue;
    if (Math.abs(delta) < 1e-9) continue;

    if (delta > 0 && (effectiveSolDelta < -1e-6 || usdcDelta < -1e-6)) {
      swaps.push({
        mint,
        side: 'buy',
        tokenDelta: delta,
        preTokenAmount: preAmounts.get(mint) ?? 0,
        solDelta: effectiveSolDelta,
        usdcDelta,
        fractionSold: null,
      });
    } else if (delta < 0 && (effectiveSolDelta > 1e-6 || usdcDelta > 1e-6)) {
      const pre = preAmounts.get(mint) ?? 0;
      swaps.push({
        mint,
        side: 'sell',
        tokenDelta: delta,
        preTokenAmount: pre,
        solDelta: effectiveSolDelta,
        usdcDelta,
        fractionSold: pre > 0 ? Math.min(1, Math.abs(delta) / pre) : 1,
      });
    }
  }
  return swaps;
}

export function short(address) {
  return address.length > 12 ? `${address.slice(0, 4)}..${address.slice(-4)}` : address;
}
