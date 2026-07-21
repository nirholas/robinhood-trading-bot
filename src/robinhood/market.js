/**
 * Robinhood Crypto market data: trading-pair catalog, new-listing detection,
 * quotes, and a rolling in-memory price history that turns raw ticks into
 * momentum fields the rule engine can filter on.
 *
 * Uses the signed client from the robinhood-mcp package when credentials are
 * configured. Without credentials (pure paper mode) it cannot reach the
 * Robinhood API, so quotes fall back to public market data resolved through
 * CoinGecko's simple-price API for the majors; that keeps paper mode honest
 * with real prices instead of fabricated ones.
 */

import {
  RobinhoodCryptoClient,
  loadCredentials,
  endpointsFor,
  MissingCredentialsError,
} from 'robinhood-mcp';

const PAIRS_TTL_MS = 5 * 60 * 1000;
const HISTORY_WINDOW_MS = 65 * 60 * 1000;

/** CoinGecko ids for the symbols Robinhood commonly lists, keyless fallback. */
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
  SHIB: 'shiba-inu',
  UNI: 'uniswap',
  LTC: 'litecoin',
  BCH: 'bitcoin-cash',
  AAVE: 'aave',
  XLM: 'stellar',
  ETC: 'ethereum-classic',
  COMP: 'compound-governance-token',
  XTZ: 'tezos',
  USDC: 'usd-coin',
  BONK: 'bonk',
  WIF: 'dogwifcoin',
  PEPE: 'pepe',
  TRUMP: 'official-trump',
  PENGU: 'pudgy-penguins',
};

export class Market {
  constructor(bus, store) {
    this.bus = bus;
    this.store = store;
    this.client = null;
    this.endpoints = null;
    this.pairsCache = { at: 0, symbols: [] };
    /** symbol -> Array<{ts, price}> */
    this.history = new Map();

    try {
      const credentials = loadCredentials();
      this.client = new RobinhoodCryptoClient(credentials);
      this.endpoints = endpointsFor(credentials.apiVersion);
    } catch (error) {
      if (!(error instanceof MissingCredentialsError)) throw error;
      this.bus?.info(
        'market.init',
        'No Robinhood credentials configured; using public price fallback (paper mode only).',
      );
    }
  }

  get hasApi() {
    return this.client !== null;
  }

  /**
   * All tradable symbols (e.g. "BTC-USD"). Cached for 5 minutes.
   * Without API credentials returns the last snapshot persisted in the store,
   * so copy-trade symbol mapping still works between restarts.
   */
  async tradingPairs(force = false) {
    if (!force && Date.now() - this.pairsCache.at < PAIRS_TTL_MS && this.pairsCache.symbols.length) {
      return this.pairsCache.symbols;
    }
    if (!this.client) {
      const stored = this.store.kvGetJson('rh_pairs', []);
      this.pairsCache = { at: Date.now(), symbols: stored };
      return stored;
    }
    const { results } = await this.client.getAllPages(this.endpoints.tradingPairs, {}, 30);
    const symbols = results
      .map((pair) => String(pair.symbol || ''))
      .filter(Boolean)
      .sort();
    this.pairsCache = { at: Date.now(), symbols };
    this.store.kvSetJson('rh_pairs', symbols);
    return symbols;
  }

  /**
   * Detect listings added since the last scan. First run seeds the snapshot
   * and reports nothing: everything is "new" on day zero and that is noise.
   *
   * @returns {Promise<string[]>} newly listed symbols
   */
  async detectNewListings() {
    const current = await this.tradingPairs(true);
    if (!current.length) return [];
    const previous = this.store.kvGetJson('rh_pairs_seen', null);
    this.store.kvSetJson('rh_pairs_seen', current);
    if (!previous) return [];
    const seen = new Set(previous);
    return current.filter((symbol) => !seen.has(symbol));
  }

  /**
   * Spread-inclusive quotes for symbols. Returns Map<symbol, {bid, ask, mid}>.
   */
  async quotes(symbols) {
    const out = new Map();
    if (!symbols.length) return out;

    if (this.client) {
      const body = await this.client.get(this.endpoints.bestBidAsk, {
        query: { symbol: symbols.map((s) => s.toUpperCase()) },
      });
      for (const row of body?.results ?? []) {
        const symbol = String(row.symbol || '');
        const bid = firstNumber(row, ['bid_inclusive_of_sell_spread', 'bid', 'bid_price', 'price']);
        const ask = firstNumber(row, ['ask_inclusive_of_buy_spread', 'ask', 'ask_price', 'price']);
        if (!symbol || (bid === null && ask === null)) continue;
        const mid = bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask);
        out.set(symbol, { bid, ask, mid });
      }
      return out;
    }

    // Keyless fallback: real public prices for the majors.
    const ids = [];
    const idToSymbol = new Map();
    for (const symbol of symbols) {
      const base = symbol.split('-')[0].toUpperCase();
      const id = COINGECKO_IDS[base];
      if (id) {
        ids.push(id);
        idToSymbol.set(id, symbol);
      }
    }
    if (!ids.length) return out;
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return out;
      const data = await response.json();
      for (const [id, entry] of Object.entries(data)) {
        const price = Number(entry?.usd);
        const symbol = idToSymbol.get(id);
        if (symbol && Number.isFinite(price) && price > 0) {
          out.set(symbol, { bid: price, ask: price, mid: price });
        }
      }
    } catch {
      // Quote loop tolerates a missed tick.
    }
    return out;
  }

  /** Record a tick and trim the rolling window. */
  recordTick(symbol, price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    let series = this.history.get(symbol);
    if (!series) {
      series = [];
      this.history.set(symbol, series);
    }
    series.push({ ts, price });
    const cutoff = ts - HISTORY_WINDOW_MS;
    while (series.length && series[0].ts < cutoff) series.shift();
  }

  /**
   * Momentum snapshot for a symbol from recorded ticks.
   * Change values are percentages; null until enough history accumulates.
   */
  momentum(symbol, now = Date.now()) {
    const series = this.history.get(symbol) ?? [];
    const last = series.at(-1)?.price ?? null;
    return {
      price: last,
      priceChange1m: percentChange(series, last, now - 60_000),
      priceChange5m: percentChange(series, last, now - 5 * 60_000),
      priceChange15m: percentChange(series, last, now - 15 * 60_000),
      priceChange1h: percentChange(series, last, now - 60 * 60_000),
    };
  }
}

function percentChange(series, last, sinceTs) {
  if (last === null || !series.length) return null;
  // Oldest tick at or after the window start; require the window to be
  // reasonably covered so a 2-tick history does not fake a 1h change.
  const anchor = series.find((point) => point.ts >= sinceTs);
  if (!anchor || anchor === series.at(-1)) return null;
  if (!Number.isFinite(anchor.price) || anchor.price <= 0) return null;
  return ((last - anchor.price) / anchor.price) * 100;
}

function firstNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}
