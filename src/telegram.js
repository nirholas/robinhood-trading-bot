/**
 * Optional Telegram bridge: pushes trade/signal/error alerts to a chat and
 * answers a few remote commands. Enabled when TELEGRAM_BOT_TOKEN is set
 * (TELEGRAM_CHAT_ID locks who may command the bot; without it, the first
 * chat to message the bot is adopted and persisted).
 *
 * Zero dependencies: Bot API over fetch with long polling.
 */

const API = 'https://api.telegram.org/bot';
const POLL_TIMEOUT_S = 50;

export class Telegram {
  constructor(bus, store, bot, settings) {
    this.bus = bus;
    this.store = store;
    this.bot = bot;
    this.token = settings.telegramToken;
    this.chatId = settings.telegramChatId || store.kvGet('tg_chat_id') || '';
    this.offset = Number(store.kvGet('tg_offset') ?? 0);
    this.running = false;
  }

  start() {
    if (!this.token) return;
    this.running = true;
    this.bus.on('event', (entry) => this.onEvent(entry));
    this.loop();
    this.bus.info('telegram.start', 'Telegram bridge active.');
  }

  stop() {
    this.running = false;
  }

  onEvent(entry) {
    if (!this.chatId) return;
    const push =
      entry.level === 'trade' ||
      entry.level === 'error' ||
      entry.kind === 'listing.new' ||
      entry.kind === 'copy.swap' ||
      entry.kind === 'risk.exit' ||
      entry.kind === 'copy.unmapped';
    if (!push) return;
    const icon =
      entry.level === 'trade' ? 'TRADE' : entry.level === 'error' ? 'ERROR' : 'SIGNAL';
    this.send(`[${icon}] ${entry.message}`).catch(() => {});
  }

  async loop() {
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', {
          offset: this.offset + 1,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message'],
        });
        for (const update of updates ?? []) {
          this.offset = update.update_id;
          this.store.kvSet('tg_offset', String(this.offset));
          await this.onMessage(update.message).catch(() => {});
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async onMessage(message) {
    const text = message?.text?.trim();
    const from = String(message?.chat?.id ?? '');
    if (!text || !from) return;

    if (!this.chatId) {
      this.chatId = from;
      this.store.kvSet('tg_chat_id', from);
      await this.send('Linked. This chat now receives robinhood-trading-bot alerts. Try /status');
      return;
    }
    if (from !== String(this.chatId)) return; // Ignore strangers.

    const [command] = text.split(/\s+/);
    switch (command) {
      case '/status': {
        const status = await this.bot.status();
        const lines = [
          `mode: ${status.mode}${status.paused ? ' (PAUSED)' : ''}`,
          `paper cash: $${status.paperCash.toFixed(2)}`,
          `positions value: $${status.positionsValueUsd.toFixed(2)}`,
          `spent today: $${status.spentTodayUsd.toFixed(2)}`,
          `wallets tracked: ${status.wallets.filter((w) => w.enabled).length}`,
        ];
        await this.send(lines.join('\n'));
        break;
      }
      case '/positions': {
        const status = await this.bot.status();
        if (!status.positions.length) return this.send('No open positions.');
        await this.send(
          status.positions
            .map(
              (p) =>
                `${p.displaySymbol ?? p.symbol}: ${Number(p.qty).toPrecision(5)} @ $${p.avg_cost.toFixed(4)}` +
                (p.pnlPct != null ? ` (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%)` : ''),
            )
            .join('\n'),
        );
        break;
      }
      case '/trades': {
        const trades = this.store.recentTrades(10);
        if (!trades.length) return this.send('No trades yet.');
        await this.send(
          trades
            .map((t) => `${t.side} ${t.symbol} $${t.quote_usd?.toFixed(2) ?? '?'} [${t.status}]`)
            .join('\n'),
        );
        break;
      }
      case '/pause':
        this.bot.risk.setPaused(true);
        await this.send('Trading paused.');
        break;
      case '/resume':
        this.bot.risk.setPaused(false);
        await this.send('Trading resumed.');
        break;
      case '/help':
      default:
        await this.send('Commands: /status /positions /trades /pause /resume');
    }
  }

  async send(text) {
    if (!this.chatId) return;
    await this.call('sendMessage', { chat_id: this.chatId, text: text.slice(0, 4000) });
  }

  async call(method, payload) {
    const response = await fetch(`${API}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000),
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.description || `telegram ${method} failed`);
    return body.result;
  }
}
