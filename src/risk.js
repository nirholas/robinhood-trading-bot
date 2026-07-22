/**
 * Bot-level risk manager. Two jobs:
 *
 * 1. checkBuy(): gate every entry (rule-based or copy) against the config
 *    caps: per-order max, daily spend, open-position count, per-symbol
 *    cooldown. Applies in paper AND live mode so paper results are honest.
 *    Live mode adds the swap slippage bound on top.
 *
 * 2. monitorExits(): walk open positions each tick and close any that hit
 *    stop loss, take profit, trailing stop, or max hold time.
 */

export class Risk {
  /**
   * @param {import('./log.js').Bus} bus
   * @param {import('./store.js').Store} store
   * @param {() => object} getConfig
   */
  constructor(bus, store, getConfig) {
    this.bus = bus;
    this.store = store;
    this.getConfig = getConfig;
  }

  get paused() {
    return this.store.kvGet('paused') === '1';
  }

  setPaused(paused) {
    this.store.kvSet('paused', paused ? '1' : '0');
    this.bus.warn('risk.pause', paused ? 'Trading PAUSED.' : 'Trading resumed.');
  }

  /** @returns {{ok: true} | {ok: false, reason: string}} */
  checkBuy(symbol, quoteUsd) {
    const risk = this.getConfig().risk ?? {};

    if (this.paused) return { ok: false, reason: 'trading is paused' };

    if (!Number.isFinite(quoteUsd) || quoteUsd < (risk.minQuoteUsd ?? 1)) {
      return { ok: false, reason: `order $${quoteUsd} below minimum $${risk.minQuoteUsd ?? 1}` };
    }
    if (quoteUsd > (risk.maxOrderUsd ?? Infinity)) {
      return { ok: false, reason: `order $${quoteUsd.toFixed(2)} exceeds maxOrderUsd $${risk.maxOrderUsd}` };
    }

    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const spent = this.store.spentSince(midnight.getTime());
    if (spent + quoteUsd > (risk.maxDailyUsd ?? Infinity)) {
      return {
        ok: false,
        reason: `daily cap: $${spent.toFixed(2)} spent + $${quoteUsd.toFixed(2)} > $${risk.maxDailyUsd}`,
      };
    }

    const openPositions = this.store.listPositions();
    const alreadyHolding = openPositions.some((position) => position.symbol === symbol);
    if (!alreadyHolding && openPositions.length >= (risk.maxOpenPositions ?? Infinity)) {
      return { ok: false, reason: `max open positions (${risk.maxOpenPositions}) reached` };
    }

    const cooldownSec = risk.perSymbolCooldownSec ?? 0;
    if (cooldownSec > 0) {
      const lastTs = this.store.lastTradeTsForSymbol(symbol);
      if (lastTs && Date.now() - lastTs < cooldownSec * 1000) {
        const wait = Math.ceil((cooldownSec * 1000 - (Date.now() - lastTs)) / 1000);
        return { ok: false, reason: `${symbol} in cooldown for another ${wait}s` };
      }
    }

    return { ok: true };
  }

  /**
   * Evaluate one position against the exit config at the current price.
   * Pure decision logic, exported through the class for unit testing.
   *
   * @returns {null | {action: 'sell', reason: string}}
   */
  exitDecision(position, price, exits, now = Date.now()) {
    if (!price || price <= 0) return null;
    const pnlPct = ((price - position.avg_cost) / position.avg_cost) * 100;

    if (exits.stopLossPct != null && pnlPct <= -Math.abs(exits.stopLossPct)) {
      return { action: 'sell', reason: `stop loss ${pnlPct.toFixed(1)}% <= -${Math.abs(exits.stopLossPct)}%` };
    }
    if (exits.takeProfitPct != null && pnlPct >= Math.abs(exits.takeProfitPct)) {
      return { action: 'sell', reason: `take profit ${pnlPct.toFixed(1)}% >= ${Math.abs(exits.takeProfitPct)}%` };
    }
    if (exits.trailingStopPct != null && position.high_water > 0) {
      const drawdownPct = ((price - position.high_water) / position.high_water) * 100;
      if (drawdownPct <= -Math.abs(exits.trailingStopPct)) {
        return {
          action: 'sell',
          reason: `trailing stop: ${drawdownPct.toFixed(1)}% off high $${position.high_water}`,
        };
      }
    }
    if (exits.maxHoldMinutes != null && now - position.opened_at > exits.maxHoldMinutes * 60_000) {
      return { action: 'sell', reason: `max hold ${exits.maxHoldMinutes}m elapsed` };
    }
    return null;
  }

  /**
   * One monitoring pass: reprice held tokens, ratchet trailing high-water
   * marks, close positions whose exit tripped. `positions.symbol` holds the
   * token address on Robinhood Chain.
   *
   * @param {import('./chain/market.js').Market} market
   * @param {import('./chain/trader.js').Trader} trader
   */
  async monitorExits(market, trader) {
    const positions = this.store.listPositions();
    if (!positions.length) return;
    const exits = this.getConfig().exits ?? {};

    for (const position of positions) {
      const token = position.symbol;
      const price = await market.priceUsd(token).catch(() => null);
      if (!price) continue;

      market.recordTick(token, price);
      if (price > position.high_water) {
        this.store.updateHighWater(token, price);
        position.high_water = price;
      }

      const decision = this.exitDecision(position, price, exits);
      if (!decision) continue;

      this.bus.warn('risk.exit', `${token}: ${decision.reason}; selling ${position.qty}.`);
      await trader.place({
        token,
        side: 'sell',
        qty: position.qty,
        source: 'exit',
        reason: decision.reason,
      });
    }
  }
}
