/**
 * Event bus + logger. One instance per bot process.
 *
 * Every notable occurrence (signal, trade, error, scanner status) flows
 * through here so the console, the SQLite event log, the dashboard SSE
 * stream, and Telegram all see the same feed.
 */

import { EventEmitter } from 'node:events';

export class Bus extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.setMaxListeners(50);
  }

  /**
   * @param {'info'|'warn'|'error'|'trade'|'signal'} level
   * @param {string} kind machine-readable event kind (e.g. 'copy.buy')
   * @param {string} message human-readable line
   * @param {object|null} data structured payload for the dashboard
   */
  log(level, kind, message, data = null) {
    const entry = { ts: Date.now(), level, kind, message, data };
    const stamp = new Date(entry.ts).toISOString();
    const line = `[${stamp}] ${level.toUpperCase().padEnd(6)} ${kind} ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
    try {
      this.store?.insertEvent(level, kind, message, data);
    } catch {
      // The event log must never take the bot down.
    }
    this.emit('event', entry);
  }

  info(kind, message, data) {
    this.log('info', kind, message, data);
  }

  warn(kind, message, data) {
    this.log('warn', kind, message, data);
  }

  error(kind, message, data) {
    this.log('error', kind, message, data);
  }
}
