/**
 * Unified trade execution: one `place()` call that routes to either the
 * paper broker (default) or the real Robinhood Crypto API via the hardened
 * Executor from the robinhood-mcp package (per-order + daily USD caps,
 * symbol allowlist, buy-only switch, all enforced at the execution layer).
 *
 * Live trading requires ALL of:
 *   MODE=live, ROBINHOOD_CRYPTO_ENABLE_TRADING=1, and valid credentials.
 * Anything less falls back to paper and says so, loudly, once.
 */

import {
  RobinhoodCryptoClient,
  loadCredentials,
  loadExecutionPolicy,
  SpendLedger,
  Executor,
  PolicyError,
  MissingCredentialsError,
  TradingDisabledError,
  assertTradingEnabled,
} from 'robinhood-mcp';

export class Trader {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('./market.js').Market} market
   * @param {'paper'|'live'} mode
   * @param {number} paperStartingUsd
   */
  constructor(bus, store, market, mode, paperStartingUsd) {
    this.bus = bus;
    this.store = store;
    this.market = market;
    this.mode = 'paper';
    this.executor = null;

    if (store.kvGet('paper_cash') === null) {
      store.kvSet('paper_cash', String(paperStartingUsd));
    }

    if (mode === 'live') {
      try {
        assertTradingEnabled();
        const credentials = loadCredentials();
        const client = new RobinhoodCryptoClient(credentials);
        const policy = loadExecutionPolicy();
        this.executor = new Executor(client, credentials, policy, new SpendLedger(policy));
        this.mode = 'live';
        bus.warn('trader.live', 'LIVE trading enabled. Orders will use real funds.', {
          maxOrderUsd: policy.maxOrderUsd,
          maxDailyUsd: policy.maxDailyUsd,
          allowlist: policy.symbolAllowlist,
          buyOnly: policy.buyOnly,
        });
      } catch (error) {
        if (error instanceof TradingDisabledError || error instanceof MissingCredentialsError) {
          bus.warn(
            'trader.fallback',
            `MODE=live requested but ${error.message} Running in PAPER mode instead.`,
          );
        } else {
          throw error;
        }
      }
    }
    if (this.mode === 'paper') {
      bus.info('trader.paper', `Paper trading. Cash: $${this.paperCash().toFixed(2)}`);
    }
  }

  paperCash() {
    return Number(this.store.kvGet('paper_cash') ?? 0);
  }

  /**
   * Execute a buy or sell.
   *
   * @param {object} order
   * @param {string} order.symbol e.g. "SOL-USD"
   * @param {'buy'|'sell'} order.side
   * @param {number} [order.quoteUsd] notional in USD (buys)
   * @param {number} [order.assetQty] asset quantity (sells)
   * @param {string} order.source 'rule' | 'copy' | 'exit' | 'manual'
   * @param {string} order.reason human-readable audit line
   * @returns {Promise<{ok: boolean, tradeId?: number, price?: number, error?: string}>}
   */
  async place(order) {
    const symbol = order.symbol.toUpperCase();
    const side = order.side;
    try {
      return this.mode === 'live'
        ? await this.placeLive({ ...order, symbol, side })
        : await this.placePaper({ ...order, symbol, side });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PolicyError ? 'blocked' : 'failed';
      this.store.insertTrade({
        mode: this.mode,
        side,
        symbol,
        quoteUsd: order.quoteUsd ?? null,
        assetQty: order.assetQty ?? null,
        source: order.source,
        reason: order.reason,
        status,
        raw: { error: message },
      });
      this.bus.error('trade.' + status, `${side} ${symbol} ${status}: ${message}`, {
        symbol,
        side,
        source: order.source,
      });
      return { ok: false, error: message };
    }
  }

  async placePaper(order) {
    const { symbol, side } = order;
    const quote = await this.market.quotes([symbol]);
    const price = side === 'buy' ? quote.get(symbol)?.ask : quote.get(symbol)?.bid;
    if (!price) throw new Error(`No price available for ${symbol}; cannot fill paper order.`);

    let quoteUsd = order.quoteUsd ?? null;
    let assetQty = order.assetQty ?? null;
    if (side === 'buy') {
      if (quoteUsd === null) throw new Error('Paper buys require quoteUsd.');
      const cash = this.paperCash();
      if (quoteUsd > cash) {
        throw new Error(`Insufficient paper cash: need $${quoteUsd.toFixed(2)}, have $${cash.toFixed(2)}.`);
      }
      assetQty = quoteUsd / price;
      this.store.kvSet('paper_cash', String(cash - quoteUsd));
    } else {
      if (assetQty === null) throw new Error('Paper sells require assetQty.');
      const position = this.store.getPosition(symbol);
      const held = position?.qty ?? 0;
      if (assetQty > held * 1.0000001) {
        throw new Error(`Cannot sell ${assetQty} ${symbol}: holding ${held}.`);
      }
      assetQty = Math.min(assetQty, held);
      quoteUsd = assetQty * price;
      this.store.kvSet('paper_cash', String(this.paperCash() + quoteUsd));
    }

    this.applyFill({ symbol, side, assetQty, price, source: order.source });
    const tradeId = this.store.insertTrade({
      mode: 'paper',
      side,
      symbol,
      quoteUsd,
      assetQty,
      price,
      source: order.source,
      reason: order.reason,
      status: 'filled',
    });
    this.bus.log(
      'trade',
      `trade.${side}`,
      `[paper] ${side} ${symbol} $${quoteUsd.toFixed(2)} @ $${formatPrice(price)} (${order.reason})`,
      { symbol, side, quoteUsd, assetQty, price, mode: 'paper', source: order.source },
    );
    return { ok: true, tradeId, price };
  }

  async placeLive(order) {
    const { symbol, side } = order;
    const request = {
      symbol,
      side,
      type: 'market',
      ...(order.quoteUsd !== undefined && order.quoteUsd !== null
        ? { quoteAmount: String(order.quoteUsd) }
        : {}),
      ...(order.assetQty !== undefined && order.assetQty !== null
        ? { assetQuantity: trimQty(order.assetQty) }
        : {}),
    };

    const result = await this.executor.submitOrder(request, true);
    if (!result.placed) {
      throw new Error('Order was not placed (guarded preview returned instead of a fill).');
    }

    const reference = await this.executor.referencePrice(symbol, side).catch(() => null);
    const price = reference ?? null;
    const quoteUsd = order.quoteUsd ?? result.notionalUsd ?? null;
    const assetQty =
      order.assetQty ?? (price && quoteUsd !== null ? quoteUsd / price : null);

    if (price && assetQty) this.applyFill({ symbol, side, assetQty, price, source: order.source });

    const orderId = result.order?.id ? String(result.order.id) : null;
    const tradeId = this.store.insertTrade({
      mode: 'live',
      side,
      symbol,
      quoteUsd,
      assetQty,
      price,
      source: order.source,
      reason: order.reason,
      orderId,
      status: 'submitted',
      raw: result.order ?? null,
    });
    this.bus.log(
      'trade',
      `trade.${side}`,
      `[LIVE] ${side} ${symbol} $${quoteUsd !== null ? quoteUsd.toFixed(2) : '?'} (${order.reason}) order=${orderId ?? 'n/a'}`,
      { symbol, side, quoteUsd, assetQty, price, mode: 'live', source: order.source, orderId },
    );
    return { ok: true, tradeId, price: price ?? undefined };
  }

  /** Keep the local position book in sync with a fill (paper and live). */
  applyFill({ symbol, side, assetQty, price, source }) {
    const existing = this.store.getPosition(symbol);
    if (side === 'buy') {
      if (existing) {
        const qty = existing.qty + assetQty;
        const avgCost = (existing.qty * existing.avg_cost + assetQty * price) / qty;
        this.store.upsertPosition({
          symbol,
          qty,
          avgCost,
          openedAt: existing.opened_at,
          source: existing.source,
          highWater: Math.max(existing.high_water, price),
        });
      } else {
        this.store.upsertPosition({
          symbol,
          qty: assetQty,
          avgCost: price,
          openedAt: Date.now(),
          source,
          highWater: price,
        });
      }
      return;
    }
    if (!existing) return;
    const remaining = existing.qty - assetQty;
    if (remaining <= existing.qty * 1e-6 || remaining <= 0) {
      this.store.removePosition(symbol);
    } else {
      this.store.upsertPosition({
        symbol,
        qty: remaining,
        avgCost: existing.avg_cost,
        openedAt: existing.opened_at,
        source: existing.source,
        highWater: existing.high_water,
      });
    }
  }
}

function formatPrice(price) {
  return price >= 1 ? price.toFixed(2) : price.toPrecision(4);
}

/** Robinhood rejects excessive decimal precision on quantities. */
function trimQty(qty) {
  return Number(qty.toPrecision(8)).toString();
}
