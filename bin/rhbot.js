#!/usr/bin/env node
/**
 * rhbot: the robinhood-trading-bot CLI.
 *
 *   rhbot start                       run the bot (web dashboard + all loops)
 *   rhbot status                      snapshot: mode, cash, positions, wallets
 *   rhbot wallets ls                  list tracked wallets
 *   rhbot wallets add <addr> [label]  track a Solana wallet
 *   rhbot wallets rm <addr>           stop tracking
 *   rhbot rules ls                    list entry rules and enabled state
 *   rhbot rules enable <name>         enable a rule
 *   rhbot rules disable <name>        disable a rule
 *   rhbot trades [n]                  recent trades
 *   rhbot signals [n]                 recent signals
 *   rhbot pause | resume              halt / resume all entries
 *   rhbot keygen                      generate a Robinhood API keypair
 */

import { loadDotEnv, loadConfig, saveConfig, dbPath, envSettings } from '../src/config.js';
import { Store } from '../src/store.js';

const [, , command, ...args] = process.argv;

loadDotEnv();

switch (command) {
  case 'start': {
    const { Bot } = await import('../src/bot.js');
    const bot = new Bot();
    await bot.start();
    break;
  }

  case 'status': {
    const store = openStore();
    const settings = envSettings();
    const positions = store.listPositions();
    const wallets = store.listWallets();
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    console.log(`mode:          ${settings.mode}${store.kvGet('paused') === '1' ? ' (PAUSED)' : ''}`);
    console.log(`paper cash:    $${Number(store.kvGet('paper_cash') ?? 0).toFixed(2)}`);
    console.log(`spent today:   $${store.spentSince(midnight.getTime()).toFixed(2)}`);
    console.log(`positions:     ${positions.length}`);
    for (const position of positions) {
      console.log(
        `  ${position.symbol.padEnd(12)} qty ${String(position.qty).slice(0, 12).padEnd(14)} avg $${position.avg_cost}`,
      );
    }
    console.log(`wallets:       ${wallets.length} (${wallets.filter((w) => w.enabled).length} enabled)`);
    store.close();
    break;
  }

  case 'wallets': {
    const store = openStore();
    const [sub, address, ...labelParts] = args;
    if (sub === 'add' && address) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        fail('address must be a base58 Solana public key');
      }
      store.addWallet(address, labelParts.join(' '));
      console.log(`Tracking ${address}`);
    } else if (sub === 'rm' && address) {
      store.removeWallet(address);
      console.log(`Removed ${address}`);
    } else {
      for (const wallet of store.listWallets()) {
        console.log(
          `${wallet.enabled ? 'on ' : 'off'}  ${wallet.address}  ${wallet.label ?? ''}`,
        );
      }
      if (!store.listWallets().length) console.log('No wallets tracked. rhbot wallets add <address> [label]');
    }
    store.close();
    break;
  }

  case 'rules': {
    const config = loadConfig();
    const [sub, name] = args;
    if ((sub === 'enable' || sub === 'disable') && name) {
      const rule = (config.entryRules ?? []).find((entry) => entry.name === name);
      if (!rule) fail(`no rule named "${name}"`);
      rule.enabled = sub === 'enable';
      saveConfig(config);
      console.log(`${rule.name}: ${rule.enabled ? 'enabled' : 'disabled'}`);
    } else {
      for (const rule of config.entryRules ?? []) {
        console.log(
          `${rule.enabled ? '[on] ' : '[off]'} ${rule.name.padEnd(28)} source=${rule.source} ` +
            `action=${rule.action?.side} $${rule.action?.quoteUsd ?? '?'}`,
        );
      }
      console.log('\nEdit rules in data/config.json or the web dashboard. Toggle: rhbot rules enable <name>');
    }
    break;
  }

  case 'trades': {
    const store = openStore();
    for (const trade of store.recentTrades(Number(args[0]) || 20).reverse()) {
      console.log(
        `${new Date(trade.ts).toISOString()}  ${trade.mode.padEnd(5)} ${trade.side.padEnd(4)} ` +
          `${trade.symbol.padEnd(12)} $${String(trade.quote_usd?.toFixed(2) ?? '?').padEnd(10)} ` +
          `${trade.source.padEnd(6)} ${trade.status}  ${trade.reason}`,
      );
    }
    store.close();
    break;
  }

  case 'signals': {
    const store = openStore();
    for (const signal of store.recentSignals(Number(args[0]) || 20).reverse()) {
      console.log(
        `${new Date(signal.ts).toISOString()}  ${signal.source.padEnd(12)} ` +
          `${String(signal.symbol ?? signal.mint ?? '').padEnd(14)} ${signal.action ?? ''}`,
      );
    }
    store.close();
    break;
  }

  case 'pause':
  case 'resume': {
    const store = openStore();
    store.kvSet('paused', command === 'pause' ? '1' : '0');
    console.log(command === 'pause' ? 'Trading paused.' : 'Trading resumed.');
    store.close();
    break;
  }

  case 'keygen': {
    // Robinhood wants an Ed25519 keypair; you register the public key at
    // robinhood.com -> Account -> Crypto -> API, and keep the seed in .env.
    const { generateKeyPairSync } = await import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' });
    const seed = der.subarray(der.length - 32).toString('base64');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    const pub = spki.subarray(spki.length - 32).toString('base64');
    console.log('Public key (register with Robinhood):');
    console.log(`  ${pub}`);
    console.log('Private key (put in .env as ROBINHOOD_CRYPTO_PRIVATE_KEY, never share):');
    console.log(`  ${seed}`);
    break;
  }

  default:
    console.log(`robinhood-trading-bot

Usage:
  rhbot start                       run the bot (dashboard + scanners + copy trader)
  rhbot status                      current mode, cash, positions, wallets
  rhbot wallets [ls|add|rm] ...     manage tracked wallets
  rhbot rules [ls|enable|disable]   manage entry rules
  rhbot trades [n]                  recent trades
  rhbot signals [n]                 recent signals
  rhbot pause | resume              halt / resume entries
  rhbot keygen                      generate a Robinhood API keypair

Config lives in data/config.json; environment in .env (see .env.example).`);
    if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
}

function openStore() {
  return new Store(dbPath());
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
