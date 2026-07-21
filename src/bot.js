/**
 * Bot orchestrator: owns the store, market, trader, scanners, copy trader,
 * risk manager, web server, and Telegram bridge, and runs the loops.
 *
 * Loops (all intervals user-configurable in config.json):
 *   - quotes:       tick prices for held + watched symbols, feeds momentum
 *   - exits:        stop loss / take profit / trailing / max hold
 *   - newListings:  Robinhood trading-pair catalog diff
 *   - newPairs:     on-chain launch scanner (pump.fun + DexScreener + RPC)
 *   - copy:         tracked-wallet polling and mirroring
 */

import { loadDotEnv, loadConfig, saveConfig, envSettings, dbPath, resolveDashToken } from './config.js';
import { Store } from './store.js';
import { Bus } from './log.js';
import { Market } from './robinhood/market.js';
import { Trader } from './robinhood/trader.js';
import { Risk } from './risk.js';
import { NewPairScanner } from './signals/newpairs.js';
import { matchRules } from './signals/rules.js';
import { WalletTracker } from './copytrade/tracker.js';
import { Mirror } from './copytrade/mirror.js';
import { startWebServer } from './web/server.js';
import { Telegram } from './telegram.js';

export class Bot {
  constructor() {
    loadDotEnv();
    this.env = envSettings();
    this.store = new Store(dbPath());
    this.bus = new Bus(this.store);
    this.config = loadConfig();
    this.market = new Market(this.bus, this.store);
    this.trader = new Trader(this.bus, this.store, this.market, this.env.mode, this.env.paperStartingUsd);
    this.risk = new Risk(this.bus, this.store, () => this.config);
    this.scanner = new NewPairScanner(this.bus, this.store, this.market, this.env.solanaRpcUrl);
    this.mirror = new Mirror(this.bus, this.store, this.market, this.trader, this.risk, () => this.config);
    this.tracker = new WalletTracker(this.bus, this.store, this.env.solanaRpcUrl, (wallet, swap) =>
      this.mirror.handleSwap(wallet, swap),
    );
    this.telegram = new Telegram(this.bus, this.store, this, this.env);
    this.timers = [];
    this.stopped = false;
  }

  updateConfig(next) {
    this.config = next;
    saveConfig(next);
    this.bus.info('config.saved', 'Configuration updated.');
  }

  /** Status snapshot for the dashboard, CLI, and Telegram. */
  async status() {
    const positions = this.store.listPositions();
    const quotes = positions.length
      ? await this.market.quotes(positions.map((position) => position.symbol)).catch(() => new Map())
      : new Map();
    let equity = 0;
    const enrichedPositions = positions.map((position) => {
      const price = quotes.get(position.symbol)?.mid ?? null;
      const value = price ? price * position.qty : null;
      if (value) equity += value;
      return {
        ...position,
        price,
        valueUsd: value,
        pnlPct: price ? ((price - position.avg_cost) / position.avg_cost) * 100 : null,
      };
    });
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    return {
      mode: this.trader.mode,
      paused: this.risk.paused,
      paperCash: this.trader.paperCash(),
      positionsValueUsd: equity,
      spentTodayUsd: this.store.spentSince(midnight.getTime()),
      positions: enrichedPositions,
      wallets: this.store.listWallets(),
      hasRobinhoodApi: this.market.hasApi,
      config: this.config,
    };
  }

  async start() {
    const settings = this.env;
    this.bus.info('bot.start', `robinhood-trading-bot starting (mode: ${this.trader.mode}).`);

    // Seed the trading-pair snapshot so listing detection has a baseline.
    await this.market.detectNewListings().catch((error) => {
      this.bus.warn('market.pairs', `Could not load Robinhood trading pairs: ${error.message}`);
    });

    const scanners = this.config.scanners ?? {};
    this.every(scanners.quotesSeconds ?? 15, () => this.tickQuotes(), 'quotes');
    this.every(scanners.quotesSeconds ?? 15, () => this.risk.monitorExits(this.market, this.trader), 'exits');
    this.every(scanners.newListingsSeconds ?? 60, () => this.scanListings(), 'listings');
    this.every(scanners.newPairsSeconds ?? 30, () => this.scanNewPairs(), 'newpairs');
    this.every(this.config.copy?.pollSeconds ?? 10, () => this.tracker.pollAll(), 'copy');

    const dashToken = resolveDashToken(this.store);
    this.web = await startWebServer(this, settings, dashToken);
    this.telegram.start();

    this.bus.info(
      'bot.ready',
      `Dashboard: http://${settings.host}:${settings.port}/?token=${dashToken}`,
    );

    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.bus.info('bot.stop', 'Shutting down.');
    for (const timer of this.timers) clearInterval(timer);
    this.telegram.stop();
    this.web?.close();
    this.store.close();
    process.exit(0);
  }

  /** Interval helper with overlap protection and error isolation. */
  every(seconds, fn, label) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (error) {
        this.bus.error(`loop.${label}`, error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    }, Math.max(3, seconds) * 1000);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** Price ticks for held positions plus symbols any enabled rule references. */
  async tickQuotes() {
    const symbols = new Set(this.store.listPositions().map((position) => position.symbol));
    for (const rule of this.config.entryRules ?? []) {
      if (rule.enabled && rule.when?.symbol?.in) {
        for (const symbol of rule.when.symbol.in) symbols.add(symbol);
      }
    }
    if (!symbols.size) return;
    const quotes = await this.market.quotes([...symbols]);
    for (const [symbol, quote] of quotes) {
      if (quote.mid) this.market.recordTick(symbol, quote.mid);
    }
  }

  async scanListings() {
    const newSymbols = await this.market.detectNewListings();
    for (const symbol of newSymbols) {
      const momentum = this.market.momentum(symbol);
      const quotes = await this.market.quotes([symbol]).catch(() => new Map());
      const signal = {
        source: 'new_listing',
        symbol,
        listedAt: Date.now(),
        price: quotes.get(symbol)?.mid ?? momentum.price,
        ...momentum,
      };
      this.bus.log('signal', 'listing.new', `NEW Robinhood listing: ${symbol}`, signal);
      await this.actOnSignal('new_listing', signal);
    }
  }

  async scanNewPairs() {
    const signals = await this.scanner.scan();
    for (const signal of signals) {
      await this.actOnSignal('new_pair', signal);
    }
  }

  /** Record a signal, run it through the rules, execute a match. */
  async actOnSignal(source, signal) {
    const { rule, evaluations } = matchRules(this.config.entryRules, source, signal);
    let action = rule ? `matched ${rule.name}` : 'no rule matched';

    if (rule) {
      const symbol = signal.robinhoodSymbol ?? signal.symbol;
      if (source === 'new_pair' && !signal.tradeableOnRobinhood) {
        action = `matched ${rule.name} but not tradeable on Robinhood`;
        this.bus.log('signal', 'rule.untradeable', `${rule.name} matched ${signal.symbol}; no Robinhood listing.`, signal);
      } else if (rule.action.side === 'buy') {
        const quoteUsd = Number(rule.action.quoteUsd);
        const gate = this.risk.checkBuy(symbol, quoteUsd);
        if (!gate.ok) {
          action = `matched ${rule.name}; blocked: ${gate.reason}`;
          this.bus.warn('rule.blocked', `${rule.name} -> ${symbol} blocked: ${gate.reason}`);
        } else {
          const result = await this.trader.place({
            symbol,
            side: 'buy',
            quoteUsd,
            source: 'rule',
            reason: `rule ${rule.name}`,
          });
          action = result.ok ? `bought $${quoteUsd} via ${rule.name}` : `failed: ${result.error}`;
        }
      }
    }

    this.store.insertSignal({
      source,
      symbol: signal.symbol ?? null,
      mint: signal.mint ?? null,
      data: { ...signal, evaluations },
      matchedRule: rule?.name ?? null,
      action,
    });
  }
}
