/**
 * Web dashboard + HTTP API + live event stream (SSE). Zero dependencies:
 * node:http serving one static page and a JSON API.
 *
 * Auth: every request needs the dashboard token, either as a Bearer header
 * or a ?token= query parameter (which the page stores in localStorage and
 * upgrades to headers). The server binds 127.0.0.1 by default; set HOST to
 * expose it and put a reverse proxy with TLS in front if you do.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { validateRules } from '../signals/rules.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

export function startWebServer(bot, settings, token) {
  const indexHtml = readFileSync(join(PUBLIC_DIR, 'index.html'));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      // The page itself loads without auth; every data route requires it.
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(indexHtml);
        return;
      }

      if (!authorized(req, url, token)) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }

      if (url.pathname === '/api/events' && req.method === 'GET') {
        sse(bot, req, res);
        return;
      }

      const body = req.method === 'POST' ? await readJson(req) : null;
      const result = await route(bot, req.method, url, body);
      if (result === undefined) json(res, 404, { error: 'not found' });
      else json(res, 200, result);
    } catch (error) {
      json(res, error.statusCode ?? 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(settings.port, settings.host, () => resolve(server));
  });
}

async function route(bot, method, url, body) {
  const path = url.pathname;

  if (method === 'GET') {
    switch (path) {
      case '/api/status':
        return bot.status();
      case '/api/signals':
        return { signals: bot.store.recentSignals(bounded(url, 100)) };
      case '/api/trades':
        return { trades: bot.store.recentTrades(bounded(url, 100)) };
      case '/api/log':
        return { events: bot.store.recentEvents(bounded(url, 200)) };
      case '/api/config':
        return bot.config;
    }
    return undefined;
  }

  if (method !== 'POST') return undefined;

  switch (path) {
    case '/api/wallets': {
      const address = String(body?.address ?? '').trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        throw badRequest('address must be a base58 Solana public key');
      }
      bot.store.addWallet(address, String(body?.label ?? '').slice(0, 60));
      bot.bus.info('wallet.add', `Tracking wallet ${address}${body?.label ? ` (${body.label})` : ''}.`);
      return { ok: true, wallets: bot.store.listWallets() };
    }
    case '/api/wallets/remove': {
      bot.store.removeWallet(String(body?.address ?? ''));
      return { ok: true, wallets: bot.store.listWallets() };
    }
    case '/api/wallets/toggle': {
      bot.store.setWalletEnabled(String(body?.address ?? ''), Boolean(body?.enabled));
      return { ok: true, wallets: bot.store.listWallets() };
    }
    case '/api/config': {
      if (!body || typeof body !== 'object') throw badRequest('config body required');
      const problems = validateRules(body.entryRules ?? []);
      if (problems.length) throw badRequest(`invalid rules: ${problems.join('; ')}`);
      bot.updateConfig(body);
      return { ok: true, config: bot.config };
    }
    case '/api/pause': {
      bot.risk.setPaused(Boolean(body?.paused));
      return { ok: true, paused: bot.risk.paused };
    }
    case '/api/trade': {
      // Manual trade from the dashboard; same risk gates as automated flow.
      const symbol = String(body?.symbol ?? '').toUpperCase();
      const side = body?.side === 'sell' ? 'sell' : 'buy';
      if (!/^[A-Z0-9]{2,12}-USD$/.test(symbol)) throw badRequest('symbol must look like SOL-USD');
      if (side === 'buy') {
        const quoteUsd = Number(body?.quoteUsd);
        if (!Number.isFinite(quoteUsd) || quoteUsd <= 0) throw badRequest('quoteUsd required');
        const gate = bot.risk.checkBuy(symbol, quoteUsd);
        if (!gate.ok) throw badRequest(`blocked: ${gate.reason}`);
        return bot.trader.place({ symbol, side, quoteUsd, source: 'manual', reason: 'manual dashboard order' });
      }
      const position = bot.store.getPosition(symbol);
      if (!position) throw badRequest(`no open position in ${symbol}`);
      const fraction = Math.min(1, Math.max(0.01, Number(body?.fraction ?? 1)));
      return bot.trader.place({
        symbol,
        side,
        assetQty: position.qty * fraction,
        source: 'manual',
        reason: `manual dashboard sell ${(fraction * 100).toFixed(0)}%`,
      });
    }
  }
  return undefined;
}

function sse(bot, req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const onEvent = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  bot.bus.on('event', onEvent);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(keepalive);
    bot.bus.off('event', onEvent);
  });
}

function authorized(req, url, token) {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  if (!presented) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(badRequest('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(badRequest('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function bounded(url, fallback) {
  const limit = Number(url.searchParams.get('limit'));
  return Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : fallback;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}
