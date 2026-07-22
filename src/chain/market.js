/**
 * Robinhood Chain market data.
 *
 * - ERC-20 metadata (symbol, name, decimals, total supply), cached in kv.
 * - The ETH/USD rate from the deepest WETH -> USDG Uniswap route (a real
 *   market rate, not an oracle guess), cached for 30 seconds.
 * - USD pricing for any token with a v3 pool, via QuoterV2 simulation.
 * - A curve-price fallback for Odyssey tokens still on the bonding curve
 *   (the scanner records each token's latest curve price here).
 * - Rolling momentum windows per token, from recorded ticks.
 */

import { quoteSwap, erc20Abi } from 'hoodchain';
import { parseEther } from 'viem';
import { ADDRESSES } from './hood.js';

const ETH_USD_TTL_MS = 30_000;
const HISTORY_WINDOW_MS = 65 * 60 * 1000;
const META_KV_PREFIX = 'tokmeta:';

export class Market {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('hoodchain').HoodClient} client
   */
  constructor(bus, store, client) {
    this.bus = bus;
    this.store = store;
    this.client = client;
    this.ethUsdCache = { at: 0, price: null };
    /** tokenAddress -> Array<{ts, price}> */
    this.history = new Map();
    /** tokenAddress -> last known bonding-curve price in USD */
    this.curvePrices = new Map();
  }

  /** ERC-20 metadata, kv-cached forever (immutable on-chain). */
  async metadata(token) {
    const key = META_KV_PREFIX + token.toLowerCase();
    const cached = this.store.kvGetJson(key);
    if (cached) return cached;

    const contract = { address: token, abi: erc20Abi };
    const [symbol, name, decimals, totalSupply] = await Promise.all([
      this.client.public.readContract({ ...contract, functionName: 'symbol' }).catch(() => '???'),
      this.client.public.readContract({ ...contract, functionName: 'name' }).catch(() => ''),
      this.client.public.readContract({ ...contract, functionName: 'decimals' }).catch(() => 18),
      this.client.public.readContract({ ...contract, functionName: 'totalSupply' }).catch(() => 0n),
    ]);
    const meta = {
      address: token,
      symbol: String(symbol),
      name: String(name),
      decimals: Number(decimals),
      totalSupply: totalSupply.toString(),
    };
    this.store.kvSetJson(key, meta);
    return meta;
  }

  /** ETH/USD from the live WETH -> USDG route. */
  async ethUsd() {
    if (Date.now() - this.ethUsdCache.at < ETH_USD_TTL_MS && this.ethUsdCache.price) {
      return this.ethUsdCache.price;
    }
    const quote = await quoteSwap(this.client, {
      tokenIn: ADDRESSES.weth,
      tokenOut: ADDRESSES.usdg,
      amountIn: parseEther('1'),
    });
    const price = Number(quote.amountOut) / 1e6; // USDG has 6 decimals
    this.ethUsdCache = { at: Date.now(), price };
    return price;
  }

  /**
   * USD price of one whole token. Pool route first; bonding-curve fallback
   * for pre-graduation Odyssey tokens; null when neither exists.
   */
  async priceUsd(token) {
    const address = token.toLowerCase();
    try {
      const meta = await this.metadata(token);
      const oneToken = 10n ** BigInt(meta.decimals);
      const [quote, eth] = await Promise.all([
        quoteSwap(this.client, {
          tokenIn: token,
          tokenOut: ADDRESSES.weth,
          amountIn: oneToken,
        }),
        this.ethUsd(),
      ]);
      const priceEth = Number(quote.amountOut) / 1e18;
      return priceEth * eth;
    } catch {
      return this.curvePrices.get(address) ?? null;
    }
  }

  /** Record a bonding-curve price (USD) observed by the scanner. */
  recordCurvePrice(token, priceUsd) {
    if (Number.isFinite(priceUsd) && priceUsd > 0) {
      this.curvePrices.set(token.toLowerCase(), priceUsd);
    }
  }

  recordTick(token, price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    const key = token.toLowerCase();
    let series = this.history.get(key);
    if (!series) {
      series = [];
      this.history.set(key, series);
    }
    series.push({ ts, price });
    const cutoff = ts - HISTORY_WINDOW_MS;
    while (series.length && series[0].ts < cutoff) series.shift();
  }

  momentum(token, now = Date.now()) {
    const series = this.history.get(token.toLowerCase()) ?? [];
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
  const anchor = series.find((point) => point.ts >= sinceTs);
  if (!anchor || anchor === series.at(-1)) return null;
  if (!Number.isFinite(anchor.price) || anchor.price <= 0) return null;
  return ((last - anchor.price) / anchor.price) * 100;
}
