# AGENTS.md

Operating notes for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Everything here is derived from the files actually in the tree, so trust it over guesses, and update it when the facts change.

## What this repository is

Automated Robinhood Crypto trading bot: rule-based entries on new pair launches (holders, dev buy, liquidity, momentum) plus copy trading that mirrors tracked wallets. Web dashboard, CLI, optional Telegram. Paper mode by default.

- Source: https://github.com/nirholas/robinhood-trading-bot
- Primary language: JavaScript
- License: Apache License 2.0 (see the LICENSE file)

## Repository layout

- `bin/`
- `src/`
- `test/`
- `README.md`
- `LICENSE`
- `package.json`

Tests live in `test/`. Add or update a test next to the code you change.

## Setup

```bash
npm install
```

## Commands

| Task | Command |
|---|---|
| start | `npm start` |
| test | `npm test` |

Run the test and lint commands above before you consider a change finished. If a command fails on code you did not touch, say so in your report instead of silently skipping it.

## Conventions

- `.env` files are gitignored; never commit credentials, and read configuration from environment variables.
- Commit messages follow Conventional Commits (`type(scope): summary`), matching the existing history.
- Read the surrounding code before adding to it, and match its naming, file organisation and error-handling style.
- Keep `README.md` accurate: if a change alters behaviour, commands or configuration, update the docs in the same commit.
- Do not leave TODO comments, stub functions, placeholder data or commented-out code behind. Finish what you start or leave it out.
- Small, focused commits with a subject line that describes the change, not the act of committing.

## Where to raise things

- Bugs and feature requests: https://github.com/nirholas/robinhood-trading-bot/issues
- Questions and ideas: https://github.com/nirholas/robinhood-trading-bot/discussions
- Security issues: report privately at https://github.com/nirholas/robinhood-trading-bot/security/advisories/new, never in a public issue.
