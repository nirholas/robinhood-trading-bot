/**
 * SQLite persistence via node:sqlite (built into Node >= 22.5, zero deps).
 *
 * Everything the bot knows lives here: tracked wallets, signals, trades,
 * positions, events, and small key/value state (scanner cursors, the paper
 * cash balance, the daily spend ledger).
 */

import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  address       TEXT PRIMARY KEY,
  label         TEXT NOT NULL DEFAULT '',
  chain         TEXT NOT NULL DEFAULT 'robinhood-chain',
  enabled       INTEGER NOT NULL DEFAULT 1,
  added_at      INTEGER NOT NULL,
  last_sig      TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  source        TEXT NOT NULL,
  symbol        TEXT,
  mint          TEXT,
  data          TEXT NOT NULL,
  matched_rule  TEXT,
  action        TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals (ts DESC);

CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  mode          TEXT NOT NULL,
  side          TEXT NOT NULL,
  symbol        TEXT NOT NULL,
  quote_usd     REAL,
  asset_qty     REAL,
  price         REAL,
  source        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  order_id      TEXT,
  status        TEXT NOT NULL,
  raw           TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades (ts DESC);

CREATE TABLE IF NOT EXISTS positions (
  symbol        TEXT PRIMARY KEY,
  qty           REAL NOT NULL,
  avg_cost      REAL NOT NULL,
  opened_at     INTEGER NOT NULL,
  source        TEXT NOT NULL,
  high_water    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  level         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  message       TEXT NOT NULL,
  data          TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);

CREATE TABLE IF NOT EXISTS kv (
  key           TEXT PRIMARY KEY,
  value         TEXT
);
`;

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // -- kv --------------------------------------------------------------------

  kvGet(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  kvSet(key, value) {
    this.db
      .prepare(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value === null ? null : String(value));
  }

  kvGetJson(key, fallback = null) {
    const raw = this.kvGet(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  kvSetJson(key, value) {
    this.kvSet(key, JSON.stringify(value));
  }

  // -- wallets ---------------------------------------------------------------

  addWallet(address, label = '', chain = 'robinhood-chain') {
    this.db
      .prepare(
        `INSERT INTO wallets (address, label, chain, enabled, added_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(address) DO UPDATE SET label = excluded.label, enabled = 1`,
      )
      .run(address, label, chain, Date.now());
  }

  removeWallet(address) {
    this.db.prepare('DELETE FROM wallets WHERE address = ?').run(address);
  }

  setWalletEnabled(address, enabled) {
    this.db.prepare('UPDATE wallets SET enabled = ? WHERE address = ?').run(enabled ? 1 : 0, address);
  }

  setWalletCursor(address, lastSig) {
    this.db.prepare('UPDATE wallets SET last_sig = ? WHERE address = ?').run(lastSig, address);
  }

  listWallets(enabledOnly = false) {
    const sql = enabledOnly
      ? 'SELECT * FROM wallets WHERE enabled = 1 ORDER BY added_at'
      : 'SELECT * FROM wallets ORDER BY added_at';
    return this.db.prepare(sql).all();
  }

  // -- signals ---------------------------------------------------------------

  insertSignal({ source, symbol = null, mint = null, data, matchedRule = null, action = null }) {
    const result = this.db
      .prepare(
        'INSERT INTO signals (ts, source, symbol, mint, data, matched_rule, action) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(Date.now(), source, symbol, mint, JSON.stringify(data), matchedRule, action);
    return Number(result.lastInsertRowid);
  }

  recentSignals(limit = 100) {
    return this.db
      .prepare('SELECT * FROM signals ORDER BY ts DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ ...row, data: safeParse(row.data) }));
  }

  // -- trades ----------------------------------------------------------------

  insertTrade(trade) {
    const result = this.db
      .prepare(
        `INSERT INTO trades (ts, mode, side, symbol, quote_usd, asset_qty, price, source, reason, order_id, status, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        trade.mode,
        trade.side,
        trade.symbol,
        trade.quoteUsd ?? null,
        trade.assetQty ?? null,
        trade.price ?? null,
        trade.source,
        trade.reason,
        trade.orderId ?? null,
        trade.status,
        trade.raw ? JSON.stringify(trade.raw) : null,
      );
    return Number(result.lastInsertRowid);
  }

  recentTrades(limit = 100) {
    return this.db.prepare('SELECT * FROM trades ORDER BY ts DESC LIMIT ?').all(limit);
  }

  /** Filled buy notional since a UTC timestamp, for the daily spend cap. */
  spentSince(sinceTs) {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(quote_usd), 0) AS total FROM trades
         WHERE ts >= ? AND side = 'buy' AND status IN ('filled', 'submitted')`,
      )
      .get(sinceTs);
    return row?.total ?? 0;
  }

  lastTradeTsForSymbol(symbol) {
    const row = this.db
      .prepare("SELECT MAX(ts) AS ts FROM trades WHERE symbol = ? AND status IN ('filled','submitted')")
      .get(symbol);
    return row?.ts ?? null;
  }

  // -- positions -------------------------------------------------------------

  getPosition(symbol) {
    return this.db.prepare('SELECT * FROM positions WHERE symbol = ?').get(symbol) ?? null;
  }

  listPositions() {
    return this.db.prepare('SELECT * FROM positions ORDER BY opened_at').all();
  }

  upsertPosition({ symbol, qty, avgCost, openedAt, source, highWater }) {
    this.db
      .prepare(
        `INSERT INTO positions (symbol, qty, avg_cost, opened_at, source, high_water)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           qty = excluded.qty, avg_cost = excluded.avg_cost, high_water = excluded.high_water,
           source = excluded.source`,
      )
      .run(symbol, qty, avgCost, openedAt, source, highWater);
  }

  updateHighWater(symbol, highWater) {
    this.db.prepare('UPDATE positions SET high_water = ? WHERE symbol = ?').run(highWater, symbol);
  }

  removePosition(symbol) {
    this.db.prepare('DELETE FROM positions WHERE symbol = ?').run(symbol);
  }

  // -- events ----------------------------------------------------------------

  insertEvent(level, kind, message, data = null) {
    this.db
      .prepare('INSERT INTO events (ts, level, kind, message, data) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), level, kind, message, data ? JSON.stringify(data) : null);
  }

  recentEvents(limit = 200) {
    return this.db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT ?').all(limit);
  }
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
