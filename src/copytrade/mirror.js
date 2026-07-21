/**
 * Copy-trade mirror: turns a tracked wallet's parsed swap into (1) a recorded
 * signal and (2), when the token maps to a Robinhood-listed symbol and copy
 * trading is enabled, a mirrored order sized by policy.
 *
 * Mint-to-symbol resolution is dynamic: a small static map covers the
 * heavily-traded Solana mints instantly, and everything else resolves through
 * DexScreener token metadata, then is checked against the live Robinhood
 * trading-pair catalog. Nothing is hardcoded to a curated list of coins.
 */

import { short } from './tracker.js';

/** Well-known Solana mints for symbols Robinhood lists, resolved instantly. */
const STATIC_MINT_SYMBOLS = new Map([
  ['So11111111111111111111111111111111111111112', 'SOL'],
  ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'BONK'],
  ['EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', 'WIF'],
  ['2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', 'PENGU'],
  ['6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', 'TRUMP'],
]);

const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/latest/dex/tokens/';
const SYMBOL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export class Mirror {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('../robinhood/market.js').Market} market
   * @param {import('../robinhood/trader.js').Trader} trader
   * @param {import('../risk.js').Risk} risk
   * @param {() => object} getConfig live config accessor
   */
  constructor(bus, store, market, trader, risk, getConfig) {
    this.bus = bus;
    this.store = store;
    this.market = market;
    this.trader = trader;
    this.risk = risk;
    this.getConfig = getConfig;
    /** mint -> {symbol, at} */
    this.symbolCache = new Map();
  }

  /** Entry point wired into WalletTracker.onSwap. */
  async handleSwap(wallet, swap) {
    const config = this.getConfig().copy ?? {};
    const solPrice = await this.solPriceUsd();
    const notionalUsd = swapNotionalUsd(swap, solPrice);
    const baseSymbol = await this.resolveSymbol(swap.mint);
    const robinhoodSymbol = baseSymbol ? `${baseSymbol}-USD` : null;
    const pairs = new Set(await this.market.tradingPairs().catch(() => []));
    const tradeable = Boolean(robinhoodSymbol && pairs.has(robinhoodSymbol));
    const label = wallet.label || short(wallet.address);

    const signal = {
      source: 'copy',
      wallet: wallet.address,
      walletLabel: label,
      side: swap.side,
      mint: swap.mint,
      symbol: robinhoodSymbol ?? baseSymbol ?? swap.mint,
      baseSymbol,
      tradeableOnRobinhood: tradeable,
      notionalUsd,
      tokenDelta: swap.tokenDelta,
      fractionSold: swap.fractionSold,
      signature: swap.signature,
    };

    let action = 'recorded';
    let executed = false;

    if (!config.enabled) {
      action = 'copy-disabled';
    } else if (!tradeable) {
      action = 'unmapped';
      if (config.alertUnmapped) {
        this.bus.log(
          'signal',
          'copy.unmapped',
          `${label} ${swap.side} ${baseSymbol ?? short(swap.mint)} (~$${fmt(notionalUsd)}); not listed on Robinhood, signal only.`,
          signal,
        );
      }
    } else if (swap.side === 'buy') {
      if (notionalUsd !== null && notionalUsd < (config.minTrackedNotionalUsd ?? 0)) {
        action = 'below-min-notional';
      } else {
        const quoteUsd = this.sizeBuy(config, notionalUsd);
        const gate = this.risk.checkBuy(robinhoodSymbol, quoteUsd);
        if (!gate.ok) {
          action = `risk-blocked: ${gate.reason}`;
          this.bus.warn('copy.blocked', `Copy buy ${robinhoodSymbol} blocked: ${gate.reason}`, signal);
        } else {
          const result = await this.trader.place({
            symbol: robinhoodSymbol,
            side: 'buy',
            quoteUsd,
            source: 'copy',
            reason: `copy ${label} buy ~$${fmt(notionalUsd)} of ${baseSymbol}`,
          });
          executed = result.ok;
          action = result.ok ? `mirrored $${quoteUsd.toFixed(2)}` : `failed: ${result.error}`;
        }
      }
    } else {
      // Sell: mirror only if we hold a position, selling the same fraction
      // the tracked wallet sold.
      if (!config.mirrorSells) {
        action = 'sells-disabled';
      } else {
        const position = this.store.getPosition(robinhoodSymbol);
        if (!position) {
          action = 'no-position';
        } else {
          const fraction = swap.fractionSold ?? 1;
          const assetQty = position.qty * fraction;
          const result = await this.trader.place({
            symbol: robinhoodSymbol,
            side: 'sell',
            assetQty,
            source: 'copy',
            reason: `copy ${label} sold ${(fraction * 100).toFixed(0)}% of ${baseSymbol}`,
          });
          executed = result.ok;
          action = result.ok
            ? `mirrored sell ${(fraction * 100).toFixed(0)}%`
            : `failed: ${result.error}`;
        }
      }
    }

    this.store.insertSignal({
      source: 'copy',
      symbol: signal.symbol,
      mint: swap.mint,
      data: signal,
      action,
    });
    if (executed || swap.side === 'buy') {
      this.bus.log(
        'signal',
        'copy.swap',
        `${label} ${swap.side} ${baseSymbol ?? short(swap.mint)} ~$${fmt(notionalUsd)} -> ${action}`,
        { ...signal, action },
      );
    }
  }

  sizeBuy(config, trackedNotionalUsd) {
    if (config.sizingMode === 'proportional' && trackedNotionalUsd) {
      const sized = trackedNotionalUsd * (config.proportionalFactor ?? 0.01);
      return clamp(sized, 1, config.maxUsd ?? 100);
    }
    return clamp(config.fixedUsd ?? 25, 1, config.maxUsd ?? 100);
  }

  async resolveSymbol(mint) {
    const staticSymbol = STATIC_MINT_SYMBOLS.get(mint);
    if (staticSymbol) return staticSymbol;

    const cached = this.symbolCache.get(mint);
    if (cached && Date.now() - cached.at < SYMBOL_CACHE_TTL_MS) return cached.symbol;

    let symbol = null;
    try {
      const response = await fetch(`${DEXSCREENER_TOKENS}${mint}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = await response.json();
        const pair = (data?.pairs ?? []).find((entry) => entry?.baseToken?.address === mint);
        const raw = pair?.baseToken?.symbol;
        if (raw && /^[A-Za-z0-9]{2,12}$/.test(raw)) symbol = raw.toUpperCase();
      }
    } catch {
      // Unresolvable now; cache the miss briefly via null entry below.
    }
    this.symbolCache.set(mint, { symbol, at: Date.now() });
    return symbol;
  }

  async solPriceUsd() {
    try {
      const quotes = await this.market.quotes(['SOL-USD']);
      return quotes.get('SOL-USD')?.mid ?? null;
    } catch {
      return null;
    }
  }
}

/** USD value of the quote side of a swap. Exported for tests. */
export function swapNotionalUsd(swap, solPriceUsd) {
  if (Math.abs(swap.usdcDelta) > 1e-6) return Math.abs(swap.usdcDelta);
  if (solPriceUsd && Math.abs(swap.solDelta) > 1e-9) {
    return Math.abs(swap.solDelta) * solPriceUsd;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmt(value) {
  return value === null || value === undefined ? '?' : Number(value).toFixed(2);
}
