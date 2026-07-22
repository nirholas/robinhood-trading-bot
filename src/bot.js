/**
 * Bot orchestrator for Robinhood Chain: owns the store, chain client, market,
 * trader, launch scanner, copy tracker, risk manager, web server, and
 * Telegram bridge, and runs the loops.
 *
 * Loops (intervals user-configurable in config.json):
 *   - newPairs: NOXA + Odyssey launch/graduation scanner
 *   - copy:     tracked-wallet polling and mirroring
 *   - exits:    stop loss / take profit / trailing / max hold on held tokens
 */

import { loadDotEnv, loadConfig, saveConfig, envSettings, dbPath, resolveDashToken } from './config.js';
import { Store } from './store.js';
import { Bus } from './log.js';
import { connect, shortAddr, explorerToken } from './chain/hood.js';
import { Market } from './chain/market.js';
import { Trader } from './chain/trader.js';
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

    const { client, address } = connect({ live: this.env.mode === 'live' });
    this.client = client;
    this.walletAddress = address;

    this.market = new Market(this.bus, this.store, client);
    this.trader = new Trader(
      this.bus,
      this.store,
      this.market,
      client,
      this.env.mode,
      address,
      this.env.paperStartingUsd,
    );
    this.risk = new Risk(this.bus, this.store, () => this.config);
    this.scanner = new NewPairScanner(this.bus, this.store, this.market, client);
    this.mirror = new Mirror(this.bus, this.store, this.market, this.trader, this.risk, () => this.config);
    this.tracker = new WalletTracker(this.bus, this.store, client, this.market, (wallet, swap) =>
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
    let equity = 0;
    const enrichedPositions = [];
    for (const position of positions) {
      const token = position.symbol;
      const [meta, price] = await Promise.all([
        this.market.metadata(token).catch(() => null),
        this.market.priceUsd(token).catch(() => null),
      ]);
      const value = price ? price * position.qty : null;
      if (value) equity += value;
      enrichedPositions.push({
        ...position,
        token,
        displaySymbol: meta?.symbol ?? shortAddr(token),
        explorer: explorerToken(token),
        price,
        valueUsd: value,
        pnlPct: price ? ((price - position.avg_cost) / position.avg_cost) * 100 : null,
      });
    }
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    return {
      chain: 'robinhood-chain-4663',
      mode: this.trader.mode,
      wallet: this.walletAddress,
      paused: this.risk.paused,
      paperCash: this.trader.paperCash(),
      positionsValueUsd: equity,
      spentTodayUsd: this.store.spentSince(midnight.getTime()),
      positions: enrichedPositions,
      wallets: this.store.listWallets(),
      config: this.config,
    };
  }

  async start() {
    const settings = this.env;
    this.bus.info('bot.start', `robinhood-trading-bot starting on Robinhood Chain (mode: ${this.trader.mode}).`);

    try {
      const [block, ethUsd] = await Promise.all([
        this.client.public.getBlockNumber(),
        this.market.ethUsd(),
      ]);
      this.bus.info('chain.connect', `Connected to chain 4663 at block ${block}. ETH/USD: $${ethUsd.toFixed(2)}.`);
    } catch (error) {
      this.bus.warn('chain.connect', `Chain RPC not reachable yet: ${error.message}. Loops will retry.`);
    }

    const scanners = this.config.scanners ?? {};
    this.every(scanners.newPairsSeconds ?? 20, () => this.scanNewPairs(), 'newpairs');
    this.every(this.config.copy?.pollSeconds ?? 10, () => this.tracker.pollAll(), 'copy');
    this.every(scanners.exitsSeconds ?? 15, () => this.risk.monitorExits(this.market, this.trader), 'exits');

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

  async scanNewPairs() {
    const signals = await this.scanner.scan();
    for (const signal of signals) {
      this.bus.log(
        'signal',
        'launch.new',
        `${signal.event === 'graduation' ? 'GRADUATION' : 'NEW LAUNCH'} [${signal.launchpad}] ` +
          `${signal.symbol} (${shortAddr(signal.token)})` +
          (signal.marketCapUsd ? ` mcap $${Math.round(signal.marketCapUsd).toLocaleString()}` : ''),
        signal,
      );
      await this.actOnSignal('new_pair', signal);
    }
  }

  /** Record a signal, run it through the rules, execute a match. */
  async actOnSignal(source, signal) {
    const { rule, evaluations } = matchRules(this.config.entryRules, source, signal);
    let action = rule ? `matched ${rule.name}` : 'no rule matched';

    if (rule && rule.action.side === 'buy') {
      const quoteUsd = Number(rule.action.quoteUsd);
      const gate = this.risk.checkBuy(signal.token, quoteUsd);
      if (!gate.ok) {
        action = `matched ${rule.name}; blocked: ${gate.reason}`;
        this.bus.warn('rule.blocked', `${rule.name} -> ${signal.symbol} blocked: ${gate.reason}`);
      } else {
        const result = await this.trader.place({
          token: signal.token,
          side: 'buy',
          quoteUsd,
          hasPool: signal.hasPool,
          source: 'rule',
          reason: `rule ${rule.name}`,
        });
        action = result.ok ? `bought $${quoteUsd} via ${rule.name}` : `failed: ${result.error}`;
      }
    }

    this.store.insertSignal({
      source,
      symbol: signal.symbol ?? null,
      mint: signal.token ?? null,
      data: { ...signal, evaluations },
      matchedRule: rule?.name ?? null,
      action,
    });
  }
}
