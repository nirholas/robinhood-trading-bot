/**
 * Trade execution on Robinhood Chain. One `place()` call, two backends:
 *
 * - Paper (default): fills at the real QuoterV2 price (or the live bonding
 *   curve price for pre-graduation Odyssey tokens) and tracks a simulated
 *   USD cash balance. Honest simulation against live markets, no fake data.
 * - Live: real Uniswap v3 swaps via hoodchain's executeSwap (quote, approve,
 *   slippage-bounded calldata, broadcast, receipt). The bot trades from a
 *   WETH balance: buys are WETH -> token sized in USD, sells token -> WETH.
 *
 * Live mode requires ALL of: MODE=live, LIVE_TRADING=1, and
 * ROBINHOOD_CHAIN_PRIVATE_KEY. Tokens still on a bonding curve (no pool) are
 * paper-tradeable but blocked in live mode with an explicit reason.
 */

import { executeSwap, erc20Abi } from 'hoodchain';
import { formatEther } from 'viem';
import { ADDRESSES, explorerTx, shortAddr } from './hood.js';

export class Trader {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('./market.js').Market} market
   * @param {import('hoodchain').HoodClient} client
   * @param {'paper'|'live'} requestedMode
   * @param {string|null} walletAddress
   * @param {number} paperStartingUsd
   */
  constructor(bus, store, market, client, requestedMode, walletAddress, paperStartingUsd) {
    this.bus = bus;
    this.store = store;
    this.market = market;
    this.client = client;
    this.walletAddress = walletAddress;
    this.slippageBps = clampInt(process.env.SLIPPAGE_BPS, 300, 1, 5000);
    this.mode = 'paper';

    if (store.kvGet('paper_cash') === null) {
      store.kvSet('paper_cash', String(paperStartingUsd));
    }

    if (requestedMode === 'live') {
      if (process.env.LIVE_TRADING?.trim() !== '1') {
        bus.warn('trader.fallback', 'MODE=live but LIVE_TRADING is not 1. Running in PAPER mode.');
      } else if (!walletAddress) {
        bus.warn(
          'trader.fallback',
          'MODE=live but ROBINHOOD_CHAIN_PRIVATE_KEY is not set. Running in PAPER mode.',
        );
      } else {
        this.mode = 'live';
        bus.warn('trader.live', `LIVE trading enabled from ${walletAddress}. Real funds at risk.`, {
          wallet: walletAddress,
          slippageBps: this.slippageBps,
        });
      }
    }
    if (this.mode === 'paper') {
      bus.info('trader.paper', `Paper trading. Cash: $${this.paperCash().toFixed(2)}`);
    }
  }

  paperCash() {
    return Number(this.store.kvGet('paper_cash') ?? 0);
  }

  /** Live WETH balance of the trading wallet, in ETH units. */
  async wethBalance() {
    if (!this.walletAddress) return null;
    const raw = await this.client.public.readContract({
      address: ADDRESSES.weth,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [this.walletAddress],
    });
    return Number(formatEther(raw));
  }

  /**
   * Execute a buy or sell.
   *
   * @param {object} order
   * @param {string} order.token ERC-20 address on Robinhood Chain
   * @param {'buy'|'sell'} order.side
   * @param {number} [order.quoteUsd] notional in USD (buys)
   * @param {number} [order.qty] whole-token quantity (sells)
   * @param {boolean} [order.hasPool] whether a v3 pool exists (from the signal)
   * @param {string} order.source 'rule' | 'copy' | 'exit' | 'manual'
   * @param {string} order.reason audit line
   */
  async place(order) {
    const token = order.token.toLowerCase();
    const side = order.side;
    try {
      const meta = await this.market.metadata(token);
      return this.mode === 'live'
        ? await this.placeLive({ ...order, token }, meta)
        : await this.placePaper({ ...order, token }, meta);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.insertTrade({
        mode: this.mode,
        side,
        symbol: token,
        quoteUsd: order.quoteUsd ?? null,
        assetQty: order.qty ?? null,
        source: order.source,
        reason: order.reason,
        status: 'failed',
        raw: { error: message },
      });
      this.bus.error('trade.failed', `${side} ${shortAddr(token)} failed: ${message}`, {
        token,
        side,
        source: order.source,
      });
      return { ok: false, error: message };
    }
  }

  async placePaper(order, meta) {
    const { token, side } = order;
    const price = await this.market.priceUsd(token);
    if (!price) throw new Error(`No price for ${meta.symbol} (${shortAddr(token)}): no pool and no curve data.`);

    let quoteUsd = order.quoteUsd ?? null;
    let qty = order.qty ?? null;
    if (side === 'buy') {
      if (quoteUsd === null) throw new Error('Paper buys require quoteUsd.');
      const cash = this.paperCash();
      if (quoteUsd > cash) {
        throw new Error(`Insufficient paper cash: need $${quoteUsd.toFixed(2)}, have $${cash.toFixed(2)}.`);
      }
      qty = quoteUsd / price;
      this.store.kvSet('paper_cash', String(cash - quoteUsd));
    } else {
      if (qty === null) throw new Error('Paper sells require qty.');
      const position = this.store.getPosition(token);
      const held = position?.qty ?? 0;
      qty = Math.min(qty, held);
      if (qty <= 0) throw new Error(`No ${meta.symbol} position to sell.`);
      quoteUsd = qty * price;
      this.store.kvSet('paper_cash', String(this.paperCash() + quoteUsd));
    }

    this.applyFill({ token, side, qty, price, source: order.source });
    const tradeId = this.store.insertTrade({
      mode: 'paper',
      side,
      symbol: token,
      quoteUsd,
      assetQty: qty,
      price,
      source: order.source,
      reason: order.reason,
      status: 'filled',
    });
    this.bus.log(
      'trade',
      `trade.${side}`,
      `[paper] ${side} ${meta.symbol} $${quoteUsd.toFixed(2)} @ $${formatPrice(price)} (${order.reason})`,
      { token, symbol: meta.symbol, side, quoteUsd, qty, price, mode: 'paper', source: order.source },
    );
    return { ok: true, tradeId, price };
  }

  async placeLive(order, meta) {
    const { token, side } = order;
    const [ethUsd, priceBefore] = await Promise.all([
      this.market.ethUsd(),
      this.market.priceUsd(token),
    ]);

    let result;
    let qty;
    let quoteUsd;
    if (side === 'buy') {
      if (!order.quoteUsd) throw new Error('Live buys require quoteUsd.');
      const amountInWei = BigInt(Math.floor((order.quoteUsd / ethUsd) * 1e18));
      const balance = await this.wethBalance();
      if (balance !== null && Number(formatEther(amountInWei)) > balance) {
        throw new Error(
          `Wallet WETH ${balance.toFixed(5)} is below the ${formatEther(amountInWei)} this buy needs. ` +
            'Fund and wrap ETH on chain 4663 first.',
        );
      }
      result = await executeSwap(
        this.client,
        { tokenIn: ADDRESSES.weth, tokenOut: token, amountIn: amountInWei },
        { slippageBps: this.slippageBps },
      );
      qty = Number(result.quote.amountOut) / 10 ** meta.decimals;
      quoteUsd = order.quoteUsd;
    } else {
      if (!order.qty) throw new Error('Live sells require qty.');
      const position = this.store.getPosition(token);
      const held = position?.qty ?? 0;
      qty = Math.min(order.qty, held);
      if (qty <= 0) throw new Error(`No ${meta.symbol} position to sell.`);
      const amountIn = BigInt(Math.floor(qty * 10 ** meta.decimals));
      result = await executeSwap(
        this.client,
        { tokenIn: token, tokenOut: ADDRESSES.weth, amountIn },
        { slippageBps: this.slippageBps },
      );
      quoteUsd = (Number(result.quote.amountOut) / 1e18) * ethUsd;
    }

    const price = priceBefore ?? (qty ? quoteUsd / qty : null);
    this.applyFill({ token, side, qty, price: price ?? 0, source: order.source });
    const tradeId = this.store.insertTrade({
      mode: 'live',
      side,
      symbol: token,
      quoteUsd,
      assetQty: qty,
      price,
      source: order.source,
      reason: order.reason,
      orderId: result.hash,
      status: 'filled',
      raw: { hash: result.hash, amountOutMinimum: result.amountOutMinimum.toString() },
    });
    this.bus.log(
      'trade',
      `trade.${side}`,
      `[LIVE] ${side} ${meta.symbol} $${quoteUsd.toFixed(2)} (${order.reason}) ${explorerTx(result.hash)}`,
      { token, symbol: meta.symbol, side, quoteUsd, qty, price, mode: 'live', source: order.source, hash: result.hash },
    );
    return { ok: true, tradeId, price: price ?? undefined, hash: result.hash };
  }

  /** Keep the position book in sync with a fill. Token address is the key. */
  applyFill({ token, side, qty, price, source }) {
    const existing = this.store.getPosition(token);
    if (side === 'buy') {
      if (existing) {
        const total = existing.qty + qty;
        const avgCost = (existing.qty * existing.avg_cost + qty * price) / total;
        this.store.upsertPosition({
          symbol: token,
          qty: total,
          avgCost,
          openedAt: existing.opened_at,
          source: existing.source,
          highWater: Math.max(existing.high_water, price),
        });
      } else {
        this.store.upsertPosition({
          symbol: token,
          qty,
          avgCost: price,
          openedAt: Date.now(),
          source,
          highWater: price,
        });
      }
      return;
    }
    if (!existing) return;
    const remaining = existing.qty - qty;
    if (remaining <= existing.qty * 1e-6 || remaining <= 0) {
      this.store.removePosition(token);
    } else {
      this.store.upsertPosition({
        symbol: token,
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

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
