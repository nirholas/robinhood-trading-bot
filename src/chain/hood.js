/**
 * Robinhood Chain client (chain ID 4663) built on the hoodchain SDK.
 *
 * Read-only by default. A wallet account attaches only when a private key is
 * configured AND live mode is fully gated on (MODE=live + LIVE_TRADING=1),
 * so a paper-mode process physically cannot sign anything.
 */

import { createHoodClient, MAINNET_ADDRESSES, MAINNET_EXPLORER_URL } from 'hoodchain';
import { privateKeyToAccount } from 'viem/accounts';

export const ADDRESSES = MAINNET_ADDRESSES;
export const EXPLORER_URL = MAINNET_EXPLORER_URL;
export const BLOCKSCOUT_API = `${MAINNET_EXPLORER_URL}/api/v2`;

/** Tokens treated as the quote side of a swap when classifying trades. */
export const QUOTE_TOKENS = new Set([
  ADDRESSES.weth.toLowerCase(),
  ADDRESSES.usdg.toLowerCase(),
]);

/** Routers whose native-ETH swaps hide the quote leg from Transfer logs. */
export const ROUTER_ADDRESSES = new Set([
  ADDRESSES.swapRouter02.toLowerCase(),
  ADDRESSES.universalRouter.toLowerCase(),
]);

/**
 * @param {{ live: boolean }} options live=true attaches the signer (requires
 *   ROBINHOOD_CHAIN_PRIVATE_KEY).
 * @returns {{ client: import('hoodchain').HoodClient, address: string|null }}
 */
export function connect({ live }) {
  const rpcUrl = process.env.ROBINHOOD_CHAIN_RPC_URL || undefined;
  const key = process.env.ROBINHOOD_CHAIN_PRIVATE_KEY?.trim();

  if (!live || !key) {
    return { client: createHoodClient({ rpcUrl }), address: null };
  }

  const account = privateKeyToAccount(normalizeKey(key));
  const client = createHoodClient({ rpcUrl, account });
  return { client, address: account.address };
}

function normalizeKey(key) {
  return key.startsWith('0x') ? key : `0x${key}`;
}

export function explorerTx(hash) {
  return `${EXPLORER_URL}/tx/${hash}`;
}

export function explorerToken(address) {
  return `${EXPLORER_URL}/token/${address}`;
}

export function shortAddr(address) {
  const value = String(address ?? '');
  return value.length > 12 ? `${value.slice(0, 6)}..${value.slice(-4)}` : value;
}
