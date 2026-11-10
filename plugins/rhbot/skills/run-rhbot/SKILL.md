---
name: run-rhbot
description: Run the rhbot Robinhood Chain trading bot from a clone in paper mode, then manage tracked wallets, entry rules, signals and trades through its CLI. Use when asked to simulate copy trading or new-launch entries on Robinhood Chain (chain ID 4663).
---

# Run rhbot (robinhood-trading-bot)

rhbot watches the NOXA and The Odyssey launchpads on Robinhood Chain (chain ID 4663), applies JSON entry rules, and can mirror tracked wallets (copy trading). It keeps one position book in SQLite and serves a web dashboard. The package is not on npm, so run it from a clone.

## Safety

Paper mode is the default and moves no funds: it simulates fills at real quoted prices. Live trading needs all three of `MODE=live`, `LIVE_TRADING=1` and `ROBINHOOD_CHAIN_PRIVATE_KEY`. Never enable live mode on your own and never ask the user to paste a key into the chat. If the user wants live trading, tell them to export those variables in their own shell, and get an explicit yes before starting. Use a burner wallet.

## Start

Requires Node.js 22.5 or newer (built-in `node:sqlite`).

```bash
git clone https://github.com/nirholas/robinhood-trading-bot
cd robinhood-trading-bot
npm install
npx rhbot start
```

`start` prints a dashboard URL with an auth token (`http://127.0.0.1:8788/?token=...`). The dashboard API needs that token as a Bearer header or `?token=` parameter. Set `DASH_TOKEN` to keep it stable.

## CLI (from `bin/rhbot.js`)

- `rhbot status`: mode, paper cash, spent today, positions, tracked wallets.
- `rhbot wallets ls`, `rhbot wallets add <0x address> [label]`, `rhbot wallets rm <address>`.
- `rhbot rules ls`, `rhbot rules enable <name>`, `rhbot rules disable <name>`. Rule bodies live in `data/config.json` or the dashboard.
- `rhbot trades [n]` and `rhbot signals [n]`: recent trades and signals (default 20).
- `rhbot pause` and `rhbot resume`: halt or resume all entries.
- `rhbot keygen`: prints a new burner address and private key. Only run it if the user asks, and do not repeat the key in the chat.

## Environment (all optional in paper mode)

`MODE` (`paper`), `LIVE_TRADING` (`0`), `ROBINHOOD_CHAIN_RPC_URL`, `SLIPPAGE_BPS` (300), `PAPER_STARTING_USD` (1000), `PORT` (8788), `HOST` (127.0.0.1), `DASH_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (optional alerts), `RHBOT_DATA_DIR` (`./data`).

## Worked example

```bash
npx rhbot wallets add 0x0000000000000000000000000000000000000001 example
npx rhbot rules ls
npx rhbot start &       # leave it scanning, then:
npx rhbot signals 10
npx rhbot trades 10
npx rhbot status
```

Rules are AND-ed conditions over signal fields (`launchpad`, `ageMinutes`, `uniqueBuyers`, `devBuyUsd`, `top10Pct`, and so on) with comparators `lt`, `lte`, `gt`, `gte`, `eq`, `neq`, `in`, `exists`. A condition on a field that could not be populated fails closed. Report results as a simulation, not a forecast.
