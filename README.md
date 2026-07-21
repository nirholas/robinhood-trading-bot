# robinhood-trading-bot

Automated trading bot for **Robinhood Crypto**. Two engines, one position book:

1. **Parameter trading**: watches new Robinhood listings and new on-chain pair launches (pump.fun and DexScreener), enriches every launch with all the data that matters (age, market cap, liquidity, volume, price change windows, holder concentration, dev buy, bonding progress, socials), and executes your declarative entry rules against it.
2. **Copy trading**: tracks any set of Solana wallets, parses every swap they make (DEX-agnostic, works for Jupiter, Raydium, pump.fun, Orca, and anything else), and mirrors their buys and sells on Robinhood with your sizing policy.

Comes with a **web dashboard** (live SSE feed, positions, wallets, rules editor, manual orders), a **CLI**, and an optional **Telegram** bridge for alerts and remote commands.

**Paper mode is the default.** Live trading is triple-gated and capped. Nothing touches real funds until you explicitly turn it on.

## Quick start

```bash
git clone https://github.com/nirholas/robinhood-trading-bot
cd robinhood-trading-bot
npm install
cp .env.example .env      # optional for paper mode
npx rhbot start
```

The bot prints a dashboard URL with an auth token, e.g. `http://127.0.0.1:8788/?token=...`. Open it, add a wallet to track, enable a rule, and watch the live feed. No Robinhood account needed for paper trading: prices come from public market data.

Requires Node.js >= 22.5 (uses the built-in `node:sqlite`). One runtime dependency: [`robinhood-mcp`](https://www.npmjs.com/package/robinhood-mcp), which provides the Ed25519-signed Robinhood Crypto API client and the hardened execution layer.

## Going live

1. Generate a keypair: `npx rhbot keygen`
2. Register the public key at Robinhood: Account, then Crypto, then API.
3. In `.env`:

```bash
ROBINHOOD_CRYPTO_API_KEY=rh-api-key...
ROBINHOOD_CRYPTO_PRIVATE_KEY=base64seed...
MODE=live
ROBINHOOD_CRYPTO_ENABLE_TRADING=1
ROBINHOOD_CRYPTO_MAX_ORDER_USD=100
ROBINHOOD_CRYPTO_MAX_DAILY_USD=500
```

All three gates (`MODE=live`, `ENABLE_TRADING=1`, valid credentials) must hold or the bot stays in paper mode and says so. The execution layer independently enforces the per-order cap, the daily cap, an optional symbol allowlist (`ROBINHOOD_CRYPTO_SYMBOL_ALLOWLIST`), and an optional buy-only switch (`ROBINHOOD_CRYPTO_BUY_ONLY=1`), on top of the bot's own risk config. Defense in depth: the bot cannot spend past either layer.

## How it works

```
                       +--------------------+
  pump.fun (launches)  |                    |
  DexScreener (market) |  New-pair scanner  |----+
  Solana RPC (holders) |                    |    |
                       +--------------------+    |     +------------+     +----------+
                                                 +---->|            |     |          |
                       +--------------------+          | Rule       |     | Risk     |      +-----------+
  Robinhood catalog -->| New-listing scanner|--------->| engine     |---->| manager  |----->| Trader    |
                       +--------------------+          |            |     |          |      | paper/live|
                                                 +---->+------------+     +----------+      +-----------+
                       +--------------------+    |                              |                 |
  Tracked wallets ---->|  Wallet tracker    |----+     exit monitor (SL/TP/trailing/max-hold) <---+
  (Solana RPC)         |  (swap parsing)    |
                       +--------------------+
```

Every signal, trade, position, and event is persisted in SQLite (`data/rhbot.db`) and streamed live to the dashboard and Telegram.

### Copy trading

Add wallets from the dashboard or CLI. The tracker polls each wallet's transactions and extracts swaps by diffing pre/post balances, so it works on any DEX or router without protocol-specific decoding:

- Tracked wallet **buys** a token: the bot resolves the token's symbol, checks it against the live Robinhood trading-pair catalog, and if listed, buys with your sizing (`fixed` USD or `proportional` to the wallet's notional, capped).
- Tracked wallet **sells**: the bot sells the **same fraction** of its own position (they sold 75%, you sell 75%).
- Token not listed on Robinhood: recorded and alerted as a signal (launch radar), never silently dropped.

Tracking starts from the moment a wallet is added; historical trades are never replayed.

### Rule-based entries

Rules are JSON, editable live from the dashboard (validated before save), the CLI, or `data/config.json`:

```json
{
  "name": "fresh-launch-momentum",
  "enabled": true,
  "source": "new_pair",
  "when": {
    "ageMinutes":      { "lte": 30 },
    "liquidityUsd":    { "gte": 20000 },
    "devBuyPct":       { "lte": 5 },
    "top10Pct":        { "lte": 40 },
    "priceChange5m":   { "gte": 10 },
    "tradeableOnRobinhood": { "eq": true }
  },
  "action": { "side": "buy", "quoteUsd": 25 }
}
```

Comparators: `lt`, `lte`, `gt`, `gte`, `eq`, `neq`, `in`, `exists`. Conditions AND together; the first matching enabled rule wins. A condition on a field the enrichment could not populate **fails closed**: partial data can never satisfy a filter by accident. The dashboard records every evaluation so you can see exactly why a rule did or did not fire.

### Signal fields

| Field | Source | Meaning |
|---|---|---|
| `ageMinutes` | pump.fun | minutes since launch |
| `marketCapUsd` | pump.fun / DexScreener | market cap |
| `priceUsd`, `liquidityUsd` | DexScreener | price and pool depth |
| `volume5mUsd`, `volume1hUsd`, `volume24hUsd` | DexScreener | volume windows |
| `priceChange5m`, `priceChange1h`, `priceChange24h` | DexScreener | percent change |
| `buys1h`, `sells1h`, `txns1h` | DexScreener | transaction counts |
| `holdersCount` | Helius DAS (when configured) | holder count |
| `top10Pct` | Solana RPC | top-10 holder share (bonding curve excluded) |
| `devBuyPct` / `devHoldPct` | Solana RPC | creator's current holding share |
| `graduated`, `bondingProgressPct` | pump.fun | bonding-curve state |
| `replyCount`, `hasTwitter`, `hasTelegram`, `hasWebsite` | pump.fun | social signals |
| `tradeableOnRobinhood`, `robinhoodSymbol` | Robinhood catalog | executable here |
| `price`, `priceChange1m/5m/15m/1h` | Robinhood quotes | for `new_listing` signals |

### Exits

Applied continuously to every position the bot opens, in paper and live mode: `takeProfitPct`, `stopLossPct`, `trailingStopPct` (ratchets on the high-water mark), `maxHoldMinutes`. Configure under `exits` in the config.

### Risk

Bot-level gates applied to **every** entry, from rules, copy trading, and manual dashboard orders alike: `maxOrderUsd`, `maxDailyUsd` (UTC day, persisted across restarts), `maxOpenPositions`, `perSymbolCooldownSec`, `minQuoteUsd`. Plus a global pause switch (dashboard button, `rhbot pause`, or `/pause` on Telegram).

## CLI

```
rhbot start                       run the bot (dashboard + scanners + copy trader)
rhbot status                      mode, cash, positions, wallets
rhbot wallets [ls|add|rm] ...     manage tracked wallets
rhbot rules [ls|enable|disable]   manage entry rules
rhbot trades [n] / signals [n]    history
rhbot pause | resume              halt / resume entries
rhbot keygen                      generate a Robinhood API keypair
```

## HTTP API

Everything the dashboard does is a JSON API you can script against (Bearer token auth):

```
GET  /api/status     GET  /api/signals    GET  /api/trades    GET  /api/log
GET  /api/config     GET  /api/events     (SSE live stream)
POST /api/wallets            {address, label}
POST /api/wallets/remove     {address}
POST /api/wallets/toggle     {address, enabled}
POST /api/config             {full config object}
POST /api/pause              {paused}
POST /api/trade              {symbol, side, quoteUsd | fraction}
```

The server binds `127.0.0.1` by default. If you expose it (`HOST=0.0.0.0`), put TLS in front.

## Telegram

Set `TELEGRAM_BOT_TOKEN` (from @BotFather). The first chat that messages the bot is linked (or pin one with `TELEGRAM_CHAT_ID`). You get pushed alerts for trades, exits, new listings, copy signals, and errors, and commands: `/status`, `/positions`, `/trades`, `/pause`, `/resume`.

## Notes and limits

- **Execution venue is Robinhood Crypto.** On-chain launches that are not listed on Robinhood are surfaced as signals but cannot be bought there. The scanners double as a launch radar for exactly that reason.
- Live orders are market orders sized in USD; fills are reconciled against the local position book at the spread-inclusive reference price.
- The public Solana RPC rate-limits holder enrichment; set `SOLANA_RPC_URL` to a Helius/QuickNode/Triton endpoint for full data (Helius also unlocks true `holdersCount` via DAS).
- The daily spend counter inside the execution layer is per-process; the bot's own `maxDailyUsd` is persisted in SQLite and survives restarts.
- This is not financial advice, and a trading bot can lose money quickly. Start in paper mode, use small caps, and keep the kill switches close.

## Development

```bash
npm test        # unit tests: rule engine, swap parsing, risk gates, store
```

The codebase is plain ES modules, no build step. `src/bot.js` is the orchestrator; every subsystem is a small, separately-testable module.

## License

Apache-2.0
