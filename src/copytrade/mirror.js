/**
 * Copy-trade mirror for Robinhood Chain: turns a tracked wallet's parsed swap
 * into (1) a recorded signal and (2), when copy trading is enabled, a
 * mirrored order sized by policy.
 *
 * Everything on the chain is addressable directly: there is no symbol-mapping
 * problem. The only execution constraint is live mode needing a Uniswap pool;
 * bonding-curve tokens mirror in paper mode and are surfaced as signals in
 * live mode until they graduate.
 */

import { quoteSwap } from 'hoodchain';
import { ADDRESSES, shortAddr } from '../chain/hood.js';

export class Mirror {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('../chain/market.js').Market} market
   * @param {import('../chain/trader.js').Trader} trader
   * @param {import('../risk.js').Risk} risk
   * @param {() => object} getConfig
   */
  constructor(bus, store, market, trader, risk, getConfig) {
    this.bus = bus;
    this.store = store;
    this.market = market;
    this.trader = trader;
    this.risk = risk;
    this.getConfig = getConfig;
    /** token -> {hasPool, at} */
    this.poolCache = new Map();
  }

  /** Entry point wired into WalletTracker.onSwap. */
  async handleSwap(wallet, swap) {
    const config = this.getConfig().copy ?? {};
    const label = wallet.label || shortAddr(wallet.address);
    const display = `${swap.symbol} (${shortAddr(swap.token)})`;

    const signal = {
      source: 'copy',
      wallet: wallet.address.toLowerCase(),
      walletLabel: label,
      side: swap.side,
      token: swap.token,
      symbol: swap.symbol,
      qty: swap.qty,
      notionalUsd: swap.notionalUsd,
      fractionSold: swap.fractionSold,
      via: swap.via,
      txHash: swap.txHash,
    };

    let action = 'recorded';
    let executed = false;

    if (!config.enabled) {
      action = 'copy-disabled';
    } else if (swap.side === 'buy') {
      if (swap.notionalUsd !== null && swap.notionalUsd < (config.minTrackedNotionalUsd ?? 0)) {
        action = 'below-min-notional';
      } else if (this.trader.mode === 'live' && !(await this.hasPool(swap.token))) {
        action = 'no-pool-live';
        this.bus.log(
          'signal',
          'copy.curve-only',
          `${label} bought ${display} on the bonding curve (~$${fmt(swap.notionalUsd)}); no pool yet, signal only in live mode.`,
          signal,
        );
      } else {
        const quoteUsd = this.sizeBuy(config, swap.notionalUsd);
        const gate = this.risk.checkBuy(swap.token, quoteUsd);
        if (!gate.ok) {
          action = `risk-blocked: ${gate.reason}`;
          this.bus.warn('copy.blocked', `Copy buy ${display} blocked: ${gate.reason}`, signal);
        } else {
          const result = await this.trader.place({
            token: swap.token,
            side: 'buy',
            quoteUsd,
            source: 'copy',
            reason: `copy ${label} buy ~$${fmt(swap.notionalUsd)} of ${swap.symbol}`,
          });
          executed = result.ok;
          action = result.ok ? `mirrored $${quoteUsd.toFixed(2)}` : `failed: ${result.error}`;
        }
      }
    } else {
      if (!config.mirrorSells) {
        action = 'sells-disabled';
      } else {
        const position = this.store.getPosition(swap.token);
        if (!position) {
          action = 'no-position';
        } else {
          const fraction = swap.fractionSold ?? 1;
          const result = await this.trader.place({
            token: swap.token,
            side: 'sell',
            qty: position.qty * fraction,
            source: 'copy',
            reason: `copy ${label} sold ${(fraction * 100).toFixed(0)}% of ${swap.symbol}`,
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
      symbol: swap.symbol,
      mint: swap.token,
      data: signal,
      action,
    });
    if (executed || swap.side === 'buy') {
      this.bus.log(
        'signal',
        'copy.swap',
        `${label} ${swap.side} ${display} ~$${fmt(swap.notionalUsd)} -> ${action}`,
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

  /** Whether a Uniswap route exists for the token (60s cached). */
  async hasPool(token) {
    const key = token.toLowerCase();
    const cached = this.poolCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.hasPool;
    let hasPool = false;
    try {
      const meta = await this.market.metadata(token);
      await quoteSwap(this.trader.client, {
        tokenIn: ADDRESSES.weth,
        tokenOut: token,
        amountIn: 10n ** 15n, // 0.001 WETH probe
      });
      hasPool = Boolean(meta);
    } catch {
      hasPool = false;
    }
    this.poolCache.set(key, { hasPool, at: Date.now() });
    return hasPool;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fmt(value) {
  return value === null || value === undefined ? '?' : Number(value).toFixed(2);
}
