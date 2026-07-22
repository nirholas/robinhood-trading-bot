# robinhood-trading-bot

Automated trading bot for **[Robinhood Chain](https://docs.robinhood.com/chain/)** (chain ID 4663), the permissionless Arbitrum Orbit L2. Two engines, one position book:

1. **Parameter trading**: watches both of the chain's launchpads, **NOXA** (instant Uniswap v3 listing) and **The Odyssey** (pump.fun-style bonding curve, including graduations), enriches every launch with the data that matters (age, price, market cap, pool liquidity, holder count, top-10 concentration, dev holding, dev buy, curve order flow: buys, sells, unique buyers, volume), and executes your declarative entry rules against it.
2. **Copy trading**: tracks any set of Robinhood Chain wallets, detects every swap they make (Uniswap in WETH, USDG, or native ETH, plus Odyssey bonding-curve trades), and mirrors their buys and sells with your sizing policy.

Comes with a **web dashboard** (live SSE feed, positions, wallets, rules editor, manual orders), a **CLI**, and an optional **Telegram** bridge for alerts and remote commands.

**Paper mode is the default** and simulates fills at real quoted prices (QuoterV2 for pooled tokens, live curve prices for bonding-curve tokens). Live trading is triple-gated. Nothing signs a transaction until you explicitly turn it on.

Built on [`hoodchain`](https://www.npmjs.com/package/hoodchain), the Robinhood Chain TypeScript SDK (Uniswap v3 swaps, launchpad watchers, verified contract addresses), plus `viem`.

## Quick start

```bash
git clone https://github.com/nirholas/robinhood-trading-bot
cd robinhood-trading-bot
npm install
npx rhbot start
```

The bot connects to the public chain RPC, prints a dashboard URL with an auth token (e.g. `http://127.0.0.1:8788/?token=...`), and starts scanning. Open the dashboard, add a wallet to track, enable a rule, watch the live feed. No wallet or key needed for paper mode.

Requires Node.js >= 22.5 (uses the built-in `node:sqlite`).

## Going live

1. Generate a burner wallet: `npx rhbot keygen`
2. Fund it with ETH on Robinhood Chain (bridge via [jumper.exchange](https://jumper.exchange)) and wrap some into WETH. Buys spend WETH; sells return WETH.
3. In `.env`:

```bash
ROBINHOOD_CHAIN_PRIVATE_KEY=0x...
MODE=live
LIVE_TRADING=1
SLIPPAGE_BPS=300
```

All three gates (`MODE=live`, `LIVE_TRADING=1`, the key) must hold or the bot stays in paper mode and says so. Live swaps go through Uniswap v3 `SwapRouter02` with slippage-bounded calldata (quote, approve, execute, receipt). Use a wallet sized to what you are willing to lose; most new launches go to zero.

Tokens still on the Odyssey bonding curve have no pool yet: they are fully tradeable in paper mode and surfaced as signals in live mode until they graduate, at which point the graduation itself is a signal you can act on.

## How it works

```
                          +----------------------+
  NOXA launches --------->|                      |
  Odyssey launches ------>|  Launch scanner      |----+
  Odyssey graduations --->|  (Blockscout logs,   |    |
  (holders, dev, curve    |   local ABI decode)  |    |     +------------+     +----------+
   flow via RPC +         +----------------------+    +---->| Rule       |     | Risk     |      +--------------+
   Blockscout)                                              | engine     |---->| manager  |----->| Trader       |
                          +----------------------+    +---->|            |     |          |      | paper / live |
  Tracked wallets ------->|  Wallet tracker      |----+     +------------+     +----------+      | Uniswap v3   |
  (Transfer logs,         |  (tx balance diff +  |                                  |            +--------------+
   Odyssey Traded events) |   curve trades)      |          exit monitor (SL/TP/trailing/max-hold) <---+
                          +----------------------+
```

Every signal, trade, position, and event is persisted in SQLite (`data/rhbot.db`) and streamed live to the dashboard and Telegram.

### Copy trading

Add 0x wallets from the dashboard or CLI. Detection is venue-agnostic, by balance diff rather than router decoding:

- ERC-20 Transfer logs where the wallet is sender or receiver are grouped per transaction and reduced to per-token deltas. Token in with WETH/USDG out is a buy on any DEX; the reverse is a sell.
- Swaps paid in **native ETH** through the routers are resolved against the transaction's own value.
- **Odyssey bonding-curve trades** are read directly from the launchpad's Traded event, which names the trader.

Mirroring: buys use your sizing (`fixed` USD or `proportional` to the tracked wallet's notional, capped); sells mirror the **same fraction** the wallet sold (they sold 75%, you sell 75%). Tracking starts from the moment a wallet is added; history is never replayed.

### Rule-based entries

Rules are JSON, editable live from the dashboard (validated before save), the CLI, or `data/config.json`:

```json
{
  "name": "odyssey-curve-momentum",
  "enabled": true,
  "source": "new_pair",
  "when": {
    "launchpad":     { "eq": "odyssey" },
    "ageMinutes":    { "lte": 60 },
    "uniqueBuyers":  { "gte": 15 },
    "curveBuys":     { "gte": 20 },
    "devBuyUsd":     { "lte": 500 },
    "top10Pct":      { "lte": 45 }
  },
  "action": { "side": "buy", "quoteUsd": 15 }
}
```

Comparators: `lt`, `lte`, `gt`, `gte`, `eq`, `neq`, `in`, `exists`. Conditions AND together; the first matching enabled rule wins. A condition on a field the enrichment could not populate **fails closed**: partial data can never satisfy a filter by accident. Every evaluation is recorded so you can see exactly why a rule did or did not fire.

### Signal fields

| Field | Source | Meaning |
|---|---|---|
| `launchpad`, `event` | launch log | `noxa` / `odyssey`; `launch` / `graduation` |
| `ageMinutes`, `launchedAt` | launch log | time since launch |
| `priceUsd` | QuoterV2 / curve trades | current price |
| `marketCapUsd` | price x total supply | market cap |
| `liquidityUsd` | pool WETH reserve | Uniswap pool depth |
| `holdersCount` | Blockscout | holder count |
| `top10Pct` | Blockscout | top-10 holder share (curve/pool excluded) |
| `devHoldPct` / `devBuyPct` | chain read | creator's current supply share |
| `devBuyEth`, `devBuyUsd` | curve Traded events | what the dev bought on the curve |
| `curveBuys`, `curveSells`, `uniqueBuyers` | curve Traded events | order flow since launch |
| `curveVolumeEth`, `curveVolumeUsd` | curve Traded events | curve volume |
| `hasPool`, `graduated`, `pool` | launch/migration log | execution venue state |
| `symbol`, `name`, `creator`, `token` | chain read | identity |

Copy signals (`source: "copy"`) carry `wallet`, `side`, `token`, `symbol`, `qty`, `notionalUsd`, `fractionSold`, `via` (`transfer-diff` or `odyssey-curve`), `txHash`.

### Exits

Applied continuously to every position the bot opens, in paper and live mode: `takeProfitPct`, `stopLossPct`, `trailingStopPct` (ratchets on the high-water mark), `maxHoldMinutes`. Configure under `exits`.

### Risk

Bot-level gates applied to **every** entry, from rules, copy trading, and manual dashboard orders alike: `maxOrderUsd`, `maxDailyUsd` (UTC day, persisted across restarts), `maxOpenPositions`, `perSymbolCooldownSec`, `minQuoteUsd`. Plus a global pause switch (dashboard button, `rhbot pause`, or `/pause` on Telegram). Live mode adds the slippage bound on top.

## CLI

```
rhbot start                       run the bot (dashboard + scanners + copy trader)
rhbot status                      mode, cash, positions, wallets
rhbot wallets [ls|add|rm] ...     manage tracked wallets (0x addresses)
rhbot rules [ls|enable|disable]   manage entry rules
rhbot trades [n] / signals [n]    history
rhbot pause | resume              halt / resume entries
rhbot keygen                      generate a burner trading wallet (chain 4663)
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
POST /api/trade              {token, side, quoteUsd | fraction}
```

The server binds `127.0.0.1` by default. If you expose it (`HOST=0.0.0.0`), put TLS in front.

## Telegram

Set `TELEGRAM_BOT_TOKEN` (from @BotFather). The first chat that messages the bot is linked (or pin one with `TELEGRAM_CHAT_ID`). You get pushed alerts for trades, exits, launches, copy signals, and errors, plus commands: `/status`, `/positions`, `/trades`, `/pause`, `/resume`.

## Notes and limits

- **Stock Tokens are not traded.** Robinhood Chain also hosts tokenized equities; they are legally restricted instruments and this bot does not buy them (the underlying SDK gates their acquisition behind an explicit eligibility flag this bot never sets).
- Launch discovery reads Blockscout's log API because the chain's public RPC silently caps `eth_getLogs` ranges; decoding happens locally against the SDK's event ABIs.
- The launchpads are low-frequency compared to Solana launchpads: quiet hours with zero launches are normal and the feed shows scanner passes either way.
- USD conversion uses the live WETH -> USDG pool rate, not an external price feed.
- This is not financial advice, and a trading bot can lose money quickly. Start in paper mode, use small caps, use a burner wallet, keep the kill switches close.

## Development

```bash
npm test        # unit tests: rule engine, swap classification, risk gates, store
```

Plain ES modules, no build step. `src/bot.js` is the orchestrator; every subsystem is a small, separately-testable module.

## License

Apache-2.0
