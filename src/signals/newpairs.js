/**
 * New-pair scanner: watches on-chain token launches and turns each one into a
 * fully-enriched signal object the rule engine can filter on.
 *
 * Sources, all keyless:
 *   - pump.fun frontend API: newest launches, creator, market cap, socials,
 *     bonding-curve state.
 *   - DexScreener: liquidity, volume, price change windows, price, FDV for
 *     anything that has a DEX pair (graduated launches).
 *   - Solana RPC: top-holder concentration (getTokenLargestAccounts) and the
 *     dev's current holding share (getTokenAccountsByOwner). With a Helius
 *     RPC configured, a true holder count via the DAS getTokenAccounts API.
 *
 * A launch that maps to a Robinhood-listed symbol is marked tradeable; the
 * bot can then execute the matched rule on Robinhood. Everything else is
 * still recorded and alerted so the feed doubles as a launch radar.
 */

const PUMP_BASE = process.env.PUMP_FRONTEND_BASE || 'https://frontend-api-v3.pump.fun';
const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens/';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_ENRICH_PER_SCAN = 8;
const PUMP_TOTAL_SUPPLY = 1_000_000_000; // pump.fun standard supply, used as fallback

export class NewPairScanner {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('../robinhood/market.js').Market} market
   * @param {string} rpcUrl
   */
  constructor(bus, store, market, rpcUrl) {
    this.bus = bus;
    this.store = store;
    this.market = market;
    this.rpcUrl = rpcUrl;
  }

  /**
   * One scan pass. Returns enriched signals for launches not seen before.
   */
  async scan() {
    const coins = await this.fetchLatestCoins();
    if (!coins.length) return [];

    const lastSeen = Number(this.store.kvGet('pump_last_created') ?? 0);
    const fresh = coins
      .filter((coin) => Number(coin.created_timestamp) > lastSeen && !coin.nsfw)
      .sort((a, b) => Number(a.created_timestamp) - Number(b.created_timestamp));

    if (fresh.length) {
      this.store.kvSet('pump_last_created', String(Number(fresh.at(-1).created_timestamp)));
    }

    const toEnrich = fresh.slice(-MAX_ENRICH_PER_SCAN);
    if (fresh.length > toEnrich.length) {
      this.bus.info(
        'newpairs.skip',
        `${fresh.length - toEnrich.length} launches skipped this pass (enrichment cap ${MAX_ENRICH_PER_SCAN}).`,
      );
    }

    const rhPairs = new Set(await this.market.tradingPairs().catch(() => []));
    const signals = [];
    for (const coin of toEnrich) {
      try {
        signals.push(await this.enrich(coin, rhPairs));
      } catch (error) {
        this.bus.warn('newpairs.enrich', `Enrichment failed for ${coin.mint}: ${error.message}`);
      }
    }
    return signals;
  }

  async fetchLatestCoins() {
    const url = `${PUMP_BASE}/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false`;
    const data = await fetchJson(url);
    if (!data) return [];
    return Array.isArray(data) ? data : Array.isArray(data?.coins) ? data.coins : [];
  }

  /** Build the full signal object for one launch. */
  async enrich(coin, rhPairs) {
    const mint = String(coin.mint);
    const createdAt = Number(coin.created_timestamp) || Date.now();
    const baseSymbol = String(coin.symbol || '').toUpperCase();
    const robinhoodSymbol = `${baseSymbol}-USD`;
    const tradeableOnRobinhood = rhPairs.has(robinhoodSymbol);

    const [dex, holderStats] = await Promise.all([
      this.dexScreener(mint),
      this.holderStats(mint, String(coin.creator || '')),
    ]);

    const marketCapUsd = pickNumber(coin.usd_market_cap, dex?.marketCap, dex?.fdv);
    const signal = {
      source: 'new_pair',
      mint,
      symbol: tradeableOnRobinhood ? robinhoodSymbol : baseSymbol,
      robinhoodSymbol: tradeableOnRobinhood ? robinhoodSymbol : null,
      tradeableOnRobinhood,
      name: String(coin.name || ''),
      creator: String(coin.creator || ''),
      createdAt,
      ageMinutes: Math.max(0, (Date.now() - createdAt) / 60_000),

      // Valuation + market data
      marketCapUsd,
      priceUsd: dex?.priceUsd ?? null,
      liquidityUsd: dex?.liquidityUsd ?? null,
      volume5mUsd: dex?.volume5mUsd ?? null,
      volume1hUsd: dex?.volume1hUsd ?? null,
      volume24hUsd: dex?.volume24hUsd ?? null,
      priceChange5m: dex?.priceChange5m ?? null,
      priceChange1h: dex?.priceChange1h ?? null,
      priceChange24h: dex?.priceChange24h ?? null,
      txns1h: dex?.txns1h ?? null,
      buys1h: dex?.buys1h ?? null,
      sells1h: dex?.sells1h ?? null,

      // Distribution
      holdersCount: holderStats.holdersCount,
      top10Pct: holderStats.top10Pct,
      devHoldPct: holderStats.devHoldPct,
      // Alias: most rule sets say "dev buy"; on a fresh launch the dev's
      // holding IS the dev buy until they move it.
      devBuyPct: holderStats.devHoldPct,

      // Launch state
      graduated: Boolean(coin.complete),
      bondingProgressPct: bondingProgress(coin),
      replyCount: Number(coin.reply_count ?? 0),
      hasTwitter: Boolean(coin.twitter),
      hasTelegram: Boolean(coin.telegram),
      hasWebsite: Boolean(coin.website),
    };
    return signal;
  }

  /** DexScreener market data for a mint; null when no DEX pair exists yet. */
  async dexScreener(mint) {
    const data = await fetchJson(`${DEXSCREENER_TOKENS}${mint}`);
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    if (!pairs.length) return null;
    // Deepest pair is the canonical market.
    const pair = pairs.reduce((best, candidate) =>
      Number(candidate?.liquidity?.usd ?? 0) > Number(best?.liquidity?.usd ?? 0) ? candidate : best,
    );
    return {
      priceUsd: pickNumber(pair.priceUsd),
      liquidityUsd: pickNumber(pair.liquidity?.usd),
      volume5mUsd: pickNumber(pair.volume?.m5),
      volume1hUsd: pickNumber(pair.volume?.h1),
      volume24hUsd: pickNumber(pair.volume?.h24),
      priceChange5m: pickNumber(pair.priceChange?.m5),
      priceChange1h: pickNumber(pair.priceChange?.h1),
      priceChange24h: pickNumber(pair.priceChange?.h24),
      txns1h: sum(pair.txns?.h1?.buys, pair.txns?.h1?.sells),
      buys1h: pickNumber(pair.txns?.h1?.buys),
      sells1h: pickNumber(pair.txns?.h1?.sells),
      marketCap: pickNumber(pair.marketCap),
      fdv: pickNumber(pair.fdv),
    };
  }

  /**
   * Holder concentration from chain state. Degrades gracefully: any RPC
   * failure yields nulls rather than a failed signal, and rules that require
   * these fields simply will not match (fail closed).
   */
  async holderStats(mint, creator) {
    const out = { holdersCount: null, top10Pct: null, devHoldPct: null };
    try {
      const [supplyRes, largestRes] = await Promise.all([
        this.rpc('getTokenSupply', [mint]),
        this.rpc('getTokenLargestAccounts', [mint]),
      ]);
      const supply = Number(supplyRes?.value?.uiAmount ?? PUMP_TOTAL_SUPPLY);
      const largest = Array.isArray(largestRes?.value) ? largestRes.value : [];
      if (supply > 0 && largest.length) {
        // Skip the single biggest account when it dwarfs everything: on a
        // bonding-curve launch that is the curve itself, not a holder.
        const amounts = largest.map((entry) => Number(entry.uiAmount ?? 0));
        const sorted = [...amounts].sort((a, b) => b - a);
        const curveLike = sorted[0] > supply * 0.5 ? sorted[0] : 0;
        const effectiveSupply = supply - curveLike;
        const holders = curveLike ? sorted.slice(1) : sorted;
        if (effectiveSupply > 0) {
          const top10 = holders.slice(0, 10).reduce((total, amount) => total + amount, 0);
          out.top10Pct = (top10 / effectiveSupply) * 100;
        }
      }
      if (creator && supply > 0) {
        const devRes = await this.rpc('getTokenAccountsByOwner', [
          creator,
          { mint },
          { encoding: 'jsonParsed' },
        ]);
        const devAmount = (devRes?.value ?? []).reduce(
          (total, account) =>
            total +
            Number(account?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
          0,
        );
        out.devHoldPct = (devAmount / supply) * 100;
      }
      // True holder count needs an indexer; Helius exposes DAS getTokenAccounts.
      if (this.rpcUrl.includes('helius')) {
        const das = await this.rpc('getTokenAccounts', {
          mint,
          limit: 1000,
          options: { showZeroBalance: false },
        }).catch(() => null);
        const accounts = das?.token_accounts ?? das?.result?.token_accounts;
        if (Array.isArray(accounts)) {
          out.holdersCount = accounts.length >= 1000 ? 1000 : accounts.length;
        }
      }
    } catch {
      // Leave nulls; the rule engine treats missing fields as non-matching.
    }
    return out;
  }

  async rpc(method, params) {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`RPC ${method} ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result;
  }
}

function bondingProgress(coin) {
  const virtualSol = Number(coin.virtual_sol_reserves);
  if (!Number.isFinite(virtualSol) || virtualSol <= 0) return coin.complete ? 100 : null;
  // pump.fun curves start at 30 virtual SOL and graduate around 115.
  const progress = ((virtualSol / 1e9 - 30) / 85) * 100;
  return Math.max(0, Math.min(100, progress));
}

function pickNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function sum(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) && !Number.isFinite(right)) return null;
  return (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0);
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
