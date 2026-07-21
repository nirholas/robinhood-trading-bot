/**
 * Bot-level risk manager. Two jobs:
 *
 * 1. checkBuy(): gate every entry (rule-based or copy) against the config
 *    caps: per-order max, daily spend, open-position count, per-symbol
 *    cooldown. Applies in paper AND live mode so paper results are honest.
 *    In live mode the robinhood-mcp execution layer enforces its own caps on
 *    top (defense in depth).
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
   * One monitoring pass: refresh quotes for held symbols, ratchet trailing
   * high-water marks, close positions whose exit tripped.
   *
   * @param {import('./robinhood/market.js').Market} market
   * @param {import('./robinhood/trader.js').Trader} trader
   */
  async monitorExits(market, trader) {
    const positions = this.store.listPositions();
    if (!positions.length) return;
    const exits = this.getConfig().exits ?? {};
    const quotes = await market.quotes(positions.map((position) => position.symbol));

    for (const position of positions) {
      const price = quotes.get(position.symbol)?.bid ?? quotes.get(position.symbol)?.mid;
      if (!price) continue;

      market.recordTick(position.symbol, price);
      if (price > position.high_water) {
        this.store.updateHighWater(position.symbol, price);
        position.high_water = price;
      }

      const decision = this.exitDecision(position, price, exits);
      if (!decision) continue;

      this.bus.warn('risk.exit', `${position.symbol}: ${decision.reason}; selling ${position.qty}.`);
      await trader.place({
        symbol: position.symbol,
        side: 'sell',
        assetQty: position.qty,
        source: 'exit',
        reason: decision.reason,
      });
    }
  }
}
