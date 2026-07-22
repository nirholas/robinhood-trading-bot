/**
 * Configuration: environment, data directory, and the user-editable bot
 * config (rules, copy-trade settings, risk limits) stored as JSON.
 *
 * Precedence: process.env > .env file > defaults. The .env parser is
 * deliberately minimal (KEY=value lines, # comments, optional quotes);
 * anything fancier belongs in the shell.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';

/** Load KEY=value pairs from a .env file into process.env (no overwrite). */
export function loadDotEnv(path = resolve(process.cwd(), '.env')) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function dataDir() {
  const dir = resolve(process.env.RHBOT_DATA_DIR || join(process.cwd(), 'data'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath() {
  return join(dataDir(), 'rhbot.db');
}

const CONFIG_FILE = () => join(dataDir(), 'config.json');

/**
 * Default bot config. Every field is user-editable from the dashboard, the
 * CLI (`rhbot rules set`), or by editing data/config.json directly.
 *
 * Entry rules evaluate against enriched signal objects. Field reference is in
 * the README ("Signal fields"); comparators: lt, lte, gt, gte, eq, neq, in,
 * exists.
 */
export const DEFAULT_CONFIG = {
  // Rule-based entries -------------------------------------------------------
  entryRules: [
    {
      name: 'noxa-fresh-launch',
      enabled: false,
      source: 'new_pair',
      when: {
        launchpad: { eq: 'noxa' },
        ageMinutes: { lte: 30 },
        liquidityUsd: { gte: 5000 },
        top10Pct: { lte: 50 },
        devHoldPct: { lte: 10 },
      },
      action: { side: 'buy', quoteUsd: 25 },
      note: 'Instant-listed NOXA launch with real liquidity and sane distribution.',
    },
    {
      name: 'odyssey-curve-momentum',
      enabled: false,
      source: 'new_pair',
      when: {
        launchpad: { eq: 'odyssey' },
        event: { eq: 'launch' },
        ageMinutes: { lte: 60 },
        uniqueBuyers: { gte: 15 },
        curveBuys: { gte: 20 },
        devBuyUsd: { lte: 500 },
      },
      action: { side: 'buy', quoteUsd: 15 },
      note: 'Bonding-curve launch with organic buyer flow and a modest dev buy. Paper-tradeable pre-graduation; live executes only once a pool exists.',
    },
    {
      name: 'odyssey-graduation',
      enabled: false,
      source: 'new_pair',
      when: {
        event: { eq: 'graduation' },
        holdersCount: { gte: 50 },
        top10Pct: { lte: 45 },
      },
      action: { side: 'buy', quoteUsd: 25 },
      note: 'Buy Odyssey tokens the moment they graduate to a Uniswap pool with a healthy holder base.',
    },
  ],

  // Exit management applied to every position the bot opens ------------------
  exits: {
    takeProfitPct: 40,
    stopLossPct: 15,
    trailingStopPct: null,
    maxHoldMinutes: null,
  },

  // Copy trading -------------------------------------------------------------
  copy: {
    enabled: true,
    // fixed: always buy `fixedUsd`. proportional: mirror the tracked wallet's
    // notional scaled by `proportionalFactor`, capped at `maxUsd`.
    sizingMode: 'fixed',
    fixedUsd: 25,
    proportionalFactor: 0.01,
    maxUsd: 100,
    minTrackedNotionalUsd: 50,
    mirrorSells: true,
    // When a tracked wallet trades a token with no Robinhood listing, still
    // record + alert the signal (true) or drop it silently (false).
    alertUnmapped: true,
    pollSeconds: 10,
  },

  // Scanners -----------------------------------------------------------------
  scanners: {
    newPairsSeconds: 20,
    exitsSeconds: 15,
  },

  // Bot-level risk (paper and live; the execution layer adds its own caps) ---
  risk: {
    maxOrderUsd: 100,
    maxDailyUsd: 500,
    maxOpenPositions: 10,
    perSymbolCooldownSec: 300,
    minQuoteUsd: 1,
  },
};

export function loadConfig() {
  const file = CONFIG_FILE();
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    return structuredClone(DEFAULT_CONFIG);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return mergeConfig(structuredClone(DEFAULT_CONFIG), parsed);
}

export function saveConfig(config) {
  writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2) + '\n');
}

/** Deep-merge user config over defaults so new fields get defaults on upgrade. */
function mergeConfig(base, override) {
  if (Array.isArray(override)) return override;
  if (override === null || typeof override !== 'object') {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] =
      base && typeof base[key] === 'object' && !Array.isArray(base[key]) && base[key] !== null
        ? mergeConfig(base[key], value)
        : Array.isArray(value) || typeof value !== 'object' || value === null
          ? value
          : mergeConfig({}, value);
  }
  return out;
}

export function envSettings() {
  return {
    mode: process.env.MODE === 'live' ? 'live' : 'paper',
    paperStartingUsd: positive(process.env.PAPER_STARTING_USD, 1000),
    port: positive(process.env.PORT, 8788),
    host: process.env.HOST || '127.0.0.1',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  };
}

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Dashboard/API auth token: env wins, else generate once and persist in kv. */
export function resolveDashToken(store) {
  const fromEnv = process.env.DASH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  let token = store.kvGet('dash_token');
  if (!token) {
    token = randomBytes(24).toString('base64url');
    store.kvSet('dash_token', token);
  }
  return token;
}
