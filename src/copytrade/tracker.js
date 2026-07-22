/**
 * Wallet tracker for Robinhood Chain: polls each tracked wallet's on-chain
 * activity and extracts swaps (what they bought or sold, and for how much).
 *
 * Detection is venue-agnostic, by log diff rather than router decoding:
 *
 *   - ERC-20 Transfer logs where the wallet is sender or receiver, grouped
 *     by transaction and reduced to per-token deltas. "Token in, WETH/USDG
 *     out" is a buy on any DEX; the reverse is a sell.
 *   - Router swaps paid in native ETH show no outgoing WETH transfer from
 *     the wallet, so token-in transactions are resolved against the
 *     transaction's own `value` and destination.
 *   - Odyssey bonding-curve trades are read directly from the launchpad's
 *     Traded event, which names the trader explicitly.
 */

import { parseAbiItem } from 'viem';
import { odysseyTradedEvent, ODYSSEY_ADDRESSES, erc20Abi } from 'hoodchain';
import { QUOTE_TOKENS, ROUTER_ADDRESSES, ADDRESSES, shortAddr } from '../chain/hood.js';

export { shortAddr as short };

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/** ~100-130ms blocks: 9000 blocks is roughly the last 15-20 minutes. */
const MAX_WINDOW_BLOCKS = 9_000n;

const ODYSSEY_FACTORIES = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
];

export class WalletTracker {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('hoodchain').HoodClient} client
   * @param {import('../chain/market.js').Market} market
   * @param {(wallet: object, swap: object) => Promise<void>} onSwap
   */
  constructor(bus, store, client, market, onSwap) {
    this.bus = bus;
    this.store = store;
    this.client = client;
    this.market = market;
    this.onSwap = onSwap;
  }

  async pollAll() {
    const wallets = this.store.listWallets(true);
    if (!wallets.length) return;
    const latest = await this.client.public.getBlockNumber();
    for (const wallet of wallets) {
      try {
        await this.pollWallet(wallet, latest);
      } catch (error) {
        this.bus.warn('copy.poll', `Poll failed for ${shortAddr(wallet.address)}: ${error.message}`);
      }
    }
  }

  async pollWallet(wallet, latest) {
    const address = wallet.address.toLowerCase();

    // First poll seeds the cursor: history is never replayed.
    if (!wallet.last_sig) {
      this.store.setWalletCursor(wallet.address, latest.toString());
      this.bus.info('copy.seed', `Tracking ${wallet.label || shortAddr(address)} from block ${latest}.`);
      return;
    }

    let from = BigInt(wallet.last_sig) + 1n;
    if (latest - from > MAX_WINDOW_BLOCKS) from = latest - MAX_WINDOW_BLOCKS;
    if (from > latest) return;
    this.store.setWalletCursor(wallet.address, latest.toString());

    const [outgoing, incoming, curveLogs] = await Promise.all([
      this.client.public.getLogs({ event: transferEvent, args: { from: wallet.address }, fromBlock: from, toBlock: latest }),
      this.client.public.getLogs({ event: transferEvent, args: { to: wallet.address }, fromBlock: from, toBlock: latest }),
      this.client.public.getLogs({
        address: ODYSSEY_FACTORIES,
        event: odysseyTradedEvent,
        args: { trader: wallet.address },
        fromBlock: from,
        toBlock: latest,
      }),
    ]);

    // Curve trades are explicit; hand them straight to the mirror.
    const curveTxHashes = new Set();
    for (const log of curveLogs) {
      curveTxHashes.add(log.transactionHash);
      const { isBuy, tokenAmount, quoteAmount } = log.args;
      await this.emitSwap(wallet, {
        token: String(log.args.token).toLowerCase(),
        side: isBuy ? 'buy' : 'sell',
        tokenDeltaRaw: isBuy ? tokenAmount : -tokenAmount,
        quoteWethWei: isBuy ? -quoteAmount : quoteAmount,
        quoteUsdgRaw: 0n,
        txHash: log.transactionHash,
        via: 'odyssey-curve',
      });
    }

    // Everything else: group transfers by transaction, diff, classify.
    const groups = groupTransfers([...outgoing, ...incoming], address);
    for (const [txHash, deltas] of groups) {
      if (curveTxHashes.has(txHash)) continue;
      let txMeta = null;
      if (needsTxLookup(deltas)) {
        const tx = await this.client.public.getTransaction({ hash: txHash }).catch(() => null);
        if (tx) txMeta = { to: tx.to ? tx.to.toLowerCase() : null, valueWei: tx.value };
      }
      for (const swap of classifySwaps(deltas, txMeta)) {
        await this.emitSwap(wallet, { ...swap, txHash, via: 'transfer-diff' });
      }
    }
  }

  /** Convert raw deltas to UI units + USD and forward to the mirror. */
  async emitSwap(wallet, swap) {
    try {
      const meta = await this.market.metadata(swap.token);
      const qty = Math.abs(Number(swap.tokenDeltaRaw)) / 10 ** meta.decimals;
      const ethUsd = await this.market.ethUsd().catch(() => null);
      const wethUsd = ethUsd ? (Math.abs(Number(swap.quoteWethWei)) / 1e18) * ethUsd : null;
      const usdgUsd = Math.abs(Number(swap.quoteUsdgRaw)) / 1e6;
      const notionalUsd = usdgUsd > 0.000001 ? usdgUsd : wethUsd;

      let fraction = null;
      if (swap.side === 'sell') {
        const balanceAfter = await this.client.public
          .readContract({
            address: swap.token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet.address],
          })
          .catch(() => null);
        if (balanceAfter !== null) {
          const sold = Math.abs(Number(swap.tokenDeltaRaw));
          const before = Number(balanceAfter) + sold;
          fraction = before > 0 ? Math.min(1, sold / before) : 1;
        }
      }

      await this.onSwap(wallet, {
        token: swap.token,
        symbol: meta.symbol,
        side: swap.side,
        qty,
        notionalUsd,
        fractionSold: fraction,
        txHash: swap.txHash,
        via: swap.via,
      });
    } catch (error) {
      this.bus.warn('copy.emit', `Swap handling failed (${shortAddr(swap.token)}): ${error.message}`);
    }
  }
}

/**
 * Group Transfer logs into per-transaction, per-token deltas for the wallet.
 * Pure function, unit-tested. Returns Map<txHash, Map<token, bigint>>.
 */
export function groupTransfers(logs, walletAddress) {
  const wallet = walletAddress.toLowerCase();
  const groups = new Map();
  const seen = new Set();
  for (const log of logs) {
    const id = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(id)) continue; // from- and to-queries can both return a self-transfer
    seen.add(id);

    const token = String(log.address).toLowerCase();
    const from = String(log.args.from).toLowerCase();
    const to = String(log.args.to).toLowerCase();
    let delta = 0n;
    if (from === wallet) delta -= log.args.value;
    if (to === wallet) delta += log.args.value;
    if (delta === 0n) continue;

    let group = groups.get(log.transactionHash);
    if (!group) {
      group = new Map();
      groups.set(log.transactionHash, group);
    }
    group.set(token, (group.get(token) ?? 0n) + delta);
  }
  return groups;
}

/** A token-in group with no quote-out needs the tx's native value checked. */
export function needsTxLookup(deltas) {
  let tokenIn = false;
  let quoteOut = false;
  for (const [token, delta] of deltas) {
    if (QUOTE_TOKENS.has(token)) {
      if (delta < 0n) quoteOut = true;
    } else if (delta > 0n) {
      tokenIn = true;
    }
  }
  return tokenIn && !quoteOut;
}

/**
 * Classify one transaction's deltas into swaps. Pure function, unit-tested.
 *
 * @param {Map<string, bigint>} deltas token -> signed raw delta for the wallet
 * @param {{to: string|null, valueWei: bigint}|null} txMeta for ETH-paid buys
 */
export function classifySwaps(deltas, txMeta = null) {
  const weth = ADDRESSES.weth.toLowerCase();
  const usdg = ADDRESSES.usdg.toLowerCase();
  const wethDelta = deltas.get(weth) ?? 0n;
  const usdgDelta = deltas.get(usdg) ?? 0n;

  // ETH sent to a router with tokens coming back is a native-ETH buy.
  const ethPaid =
    txMeta && txMeta.valueWei > 0n && txMeta.to && ROUTER_ADDRESSES.has(txMeta.to)
      ? txMeta.valueWei
      : 0n;

  const swaps = [];
  for (const [token, delta] of deltas) {
    if (QUOTE_TOKENS.has(token) || delta === 0n) continue;

    if (delta > 0n && (wethDelta < 0n || usdgDelta < 0n || ethPaid > 0n)) {
      swaps.push({
        token,
        side: 'buy',
        tokenDeltaRaw: delta,
        quoteWethWei: wethDelta < 0n ? wethDelta : -ethPaid,
        quoteUsdgRaw: usdgDelta < 0n ? usdgDelta : 0n,
      });
    } else if (delta < 0n && (wethDelta > 0n || usdgDelta > 0n)) {
      swaps.push({
        token,
        side: 'sell',
        tokenDeltaRaw: delta,
        quoteWethWei: wethDelta > 0n ? wethDelta : 0n,
        quoteUsdgRaw: usdgDelta > 0n ? usdgDelta : 0n,
      });
    }
    // Token in with no quote out and no router ETH: an airdrop or plain
    // transfer, not a trade. Token out with nothing back: a send. Both skipped.
  }
  return swaps;
}
