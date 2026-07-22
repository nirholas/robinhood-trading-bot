/**
 * New-pair scanner for Robinhood Chain's two launchpads:
 *
 *   - NOXA: instant Uniswap v3 listing (pool exists from block one).
 *   - The Odyssey: pump.fun-style bonding curve across three factories; a
 *     pool appears at graduation (PoolMigrated), which is also a signal.
 *
 * Discovery reads Blockscout's per-address log API (newest-first, no block
 * range to guess) rather than raw eth_getLogs: the chain's public RPC caps
 * log queries silently, and the launchpads are low-frequency enough that the
 * indexer is both fresher and cheaper. Raw topics + data are decoded locally
 * with the SDK's own event ABIs, so no trust is placed in indexer decoding.
 *
 * Every launch becomes a fully-enriched signal for the rule engine:
 * metadata, age, price, market cap, pool liquidity, holder count and
 * concentration, the dev's current holding share, and for curve tokens the
 * live order flow (buys, sells, unique buyers, volume, dev buy).
 * Enrichment failures degrade to nulls; rules on missing fields fail closed.
 */

import { decodeEventLog, encodeEventTopics } from 'viem';
import {
  noxaTokenLaunchedEvent,
  odysseyTokenCreatedEvent,
  odysseyTradedEvent,
  odysseyPoolMigratedEvent,
  NOXA_ADDRESSES,
  ODYSSEY_ADDRESSES,
  erc20Abi,
} from 'hoodchain';
import { ADDRESSES, BLOCKSCOUT_API, shortAddr } from '../chain/hood.js';

const MAX_ENRICH_PER_SCAN = 8;
const FETCH_TIMEOUT_MS = 12_000;
/** Curve-stats log window after launch, chunked to stay under RPC caps. */
const CURVE_WINDOW_BLOCKS = 30_000n;
const CURVE_CHUNK_BLOCKS = 10_000n;

const ODYSSEY_FACTORIES = [
  ODYSSEY_ADDRESSES.bondingCurveFactory,
  ODYSSEY_ADDRESSES.reflectionFactory,
  ODYSSEY_ADDRESSES.instantFactory,
];

/** Every (factory, event) stream the scanner watches. */
const SOURCES = [
  { launchpad: 'noxa', kind: 'launch', address: NOXA_ADDRESSES.launchFactory, event: noxaTokenLaunchedEvent },
  ...ODYSSEY_FACTORIES.map((address) => ({
    launchpad: 'odyssey',
    kind: 'launch',
    address,
    event: odysseyTokenCreatedEvent,
  })),
  ...ODYSSEY_FACTORIES.map((address) => ({
    launchpad: 'odyssey',
    kind: 'graduation',
    address,
    event: odysseyPoolMigratedEvent,
  })),
];

export class NewPairScanner {
  /**
   * @param {import('../log.js').Bus} bus
   * @param {import('../store.js').Store} store
   * @param {import('../chain/market.js').Market} market
   * @param {import('hoodchain').HoodClient} client
   */
  constructor(bus, store, market, client) {
    this.bus = bus;
    this.store = store;
    this.market = market;
    this.client = client;
  }

  /** One scan pass across every launchpad stream. */
  async scan() {
    const cursorRaw = this.store.kvGet('chain_scan_cursor');
    // Sequential on purpose: a parallel burst trips Blockscout rate limits
    // and the failures would read as "no launches".
    const events = [];
    let failedStreams = 0;
    for (const source of SOURCES) {
      const stream = await this.fetchStream(source);
      if (stream === null) failedStreams += 1;
      else events.push(...stream);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (failedStreams) {
      this.bus.warn('newpairs.stream', `${failedStreams}/${SOURCES.length} launchpad streams failed this pass.`);
    }
    const maxBlock = events.reduce((max, event) => (event.blockNumber > max ? event.blockNumber : max), 0n);

    if (cursorRaw === null) {
      // First run seeds the cursor: day-zero history is noise, not signal.
      this.store.kvSet('chain_scan_cursor', (maxBlock || 0n).toString());
      this.bus.info('newpairs.seed', `Launch scanner armed. Watching ${SOURCES.length} launchpad streams.`);
      return [];
    }

    const cursor = BigInt(cursorRaw);
    const fresh = events
      .filter((event) => event.blockNumber > cursor)
      .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));
    if (maxBlock > cursor) this.store.kvSet('chain_scan_cursor', maxBlock.toString());
    if (!fresh.length) return [];

    const toEnrich = fresh.slice(0, MAX_ENRICH_PER_SCAN);
    if (fresh.length > toEnrich.length) {
      this.bus.info(
        'newpairs.skip',
        `${fresh.length - toEnrich.length} launch events skipped this pass (enrichment cap ${MAX_ENRICH_PER_SCAN}).`,
      );
    }

    const signals = [];
    for (const event of toEnrich) {
      try {
        signals.push(await this.enrich(event));
      } catch (error) {
        this.bus.warn('newpairs.enrich', `Enrichment failed for ${shortAddr(event.token)}: ${error.message}`);
      }
    }
    return signals;
  }

  /** Newest logs for one (factory, event) stream, decoded locally. Null on fetch failure. */
  async fetchStream(source) {
    const topic0 = encodeEventTopics({ abi: [source.event] })[0];
    const data = await fetchJson(
      `${BLOCKSCOUT_API}/addresses/${source.address}/logs?topic=${topic0}`,
    );
    if (data === null) return null;
    const items = Array.isArray(data?.items) ? data.items : [];
    const events = [];
    for (const item of items) {
      try {
        const decoded = decodeEventLog({
          abi: [source.event],
          data: item.data ?? '0x',
          topics: item.topics,
        });
        const args = decoded.args;
        events.push({
          kind: source.kind,
          launchpad: source.launchpad,
          token: String(args.token).toLowerCase(),
          creator: args.deployer
            ? String(args.deployer).toLowerCase()
            : args.creator
              ? String(args.creator).toLowerCase()
              : null,
          pool: args.pool ? String(args.pool).toLowerCase() : null,
          blockNumber: BigInt(item.block_number ?? 0),
          timestamp: item.block_timestamp ? Date.parse(item.block_timestamp) : null,
          transactionHash: item.transaction_hash ?? item.tx_hash ?? null,
        });
      } catch {
        // A log this ABI cannot decode is another event sharing the address.
      }
    }
    return events;
  }

  /** Build the full signal object for one launch or graduation event. */
  async enrich(event) {
    const token = event.token;
    const [meta, ethUsd] = await Promise.all([
      this.market.metadata(token),
      this.market.ethUsd().catch(() => null),
    ]);
    let launchedAt = event.timestamp;
    if (!launchedAt) {
      const block = await this.client.public.getBlock({ blockNumber: event.blockNumber }).catch(() => null);
      launchedAt = block ? Number(block.timestamp) * 1000 : Date.now();
    }
    const hasPool = Boolean(event.pool) || event.launchpad === 'noxa' || event.kind === 'graduation';

    const [curve, holderStats, devHoldPct, pool] = await Promise.all([
      event.launchpad === 'odyssey' ? this.curveStats(token, event, ethUsd) : Promise.resolve(null),
      this.holderStats(token, meta),
      event.creator ? this.devHoldPct(token, event.creator, meta) : Promise.resolve(null),
      event.pool ? this.poolStats(event.pool, ethUsd) : Promise.resolve(null),
    ]);

    let priceUsd = await this.market.priceUsd(token);
    if (!priceUsd && curve?.lastPriceUsd) {
      this.market.recordCurvePrice(token, curve.lastPriceUsd);
      priceUsd = curve.lastPriceUsd;
    }
    const supply = Number(meta.totalSupply) / 10 ** meta.decimals;
    const marketCapUsd = priceUsd && supply ? priceUsd * supply : null;

    return {
      source: 'new_pair',
      event: event.kind,
      launchpad: event.launchpad,
      token,
      pool: event.pool,
      symbol: meta.symbol,
      name: meta.name,
      creator: event.creator,
      launchedAt,
      ageMinutes: Math.max(0, (Date.now() - launchedAt) / 60_000),

      hasPool,
      graduated: event.launchpad === 'noxa' ? true : hasPool,

      priceUsd,
      marketCapUsd,
      liquidityUsd: pool?.liquidityUsd ?? null,

      holdersCount: holderStats.holdersCount,
      top10Pct: holderStats.top10Pct,
      devHoldPct,
      devBuyPct: devHoldPct,
      devBuyEth: curve?.devBuyEth ?? null,
      devBuyUsd: curve?.devBuyUsd ?? null,

      curveBuys: curve?.buys ?? null,
      curveSells: curve?.sells ?? null,
      uniqueBuyers: curve?.uniqueBuyers ?? null,
      curveVolumeEth: curve?.volumeEth ?? null,
      curveVolumeUsd: curve?.volumeUsd ?? null,

      transactionHash: event.transactionHash,
    };
  }

  /** Aggregate bonding-curve order flow after launch (chunked, bounded). */
  async curveStats(token, event, ethUsd) {
    try {
      const latest = await this.client.public.getBlockNumber();
      const from = event.blockNumber;
      const to = from + CURVE_WINDOW_BLOCKS > latest ? latest : from + CURVE_WINDOW_BLOCKS;

      const logs = [];
      for (let start = from; start <= to; start += CURVE_CHUNK_BLOCKS) {
        const end = start + CURVE_CHUNK_BLOCKS - 1n > to ? to : start + CURVE_CHUNK_BLOCKS - 1n;
        const chunk = await this.client.public.getLogs({
          address: ODYSSEY_FACTORIES,
          event: odysseyTradedEvent,
          args: { token: event.token },
          fromBlock: start,
          toBlock: end,
        });
        logs.push(...chunk);
      }

      let buys = 0;
      let sells = 0;
      let volumeWei = 0n;
      let devBuyWei = 0n;
      let lastPriceUsd = null;
      const buyers = new Set();
      for (const log of logs) {
        const { trader, isBuy, tokenAmount, quoteAmount } = log.args;
        if (isBuy) {
          buys += 1;
          buyers.add(String(trader).toLowerCase());
          if (event.creator && String(trader).toLowerCase() === event.creator) {
            devBuyWei += quoteAmount;
          }
        } else {
          sells += 1;
        }
        volumeWei += quoteAmount;
        if (tokenAmount > 0n && ethUsd) {
          lastPriceUsd = (Number(quoteAmount) / Number(tokenAmount)) * ethUsd;
        }
      }
      const volumeEth = Number(volumeWei) / 1e18;
      const devBuyEth = Number(devBuyWei) / 1e18;
      return {
        buys,
        sells,
        uniqueBuyers: buyers.size,
        volumeEth,
        volumeUsd: ethUsd ? volumeEth * ethUsd : null,
        devBuyEth,
        devBuyUsd: ethUsd ? devBuyEth * ethUsd : null,
        lastPriceUsd,
      };
    } catch {
      return null;
    }
  }

  /** Holder count + top-10 concentration from Blockscout. */
  async holderStats(token, meta) {
    const out = { holdersCount: null, top10Pct: null };
    try {
      const info = await fetchJson(`${BLOCKSCOUT_API}/tokens/${token}`);
      const holders = Number(info?.holders ?? info?.holders_count);
      if (Number.isFinite(holders)) out.holdersCount = holders;

      const page = await fetchJson(`${BLOCKSCOUT_API}/tokens/${token}/holders`);
      const items = Array.isArray(page?.items) ? page.items : [];
      const supply = Number(meta.totalSupply);
      if (items.length && supply > 0) {
        const top10 = items
          .map((item) => Number(item.value ?? 0))
          .sort((a, b) => b - a)
          .filter((value, index) => {
            // The single dominant account on a fresh launch is the curve or
            // the pool, not a holder; exclude it from concentration.
            return !(index === 0 && value > supply * 0.5);
          })
          .slice(0, 10)
          .reduce((total, value) => total + value, 0);
        out.top10Pct = (top10 / supply) * 100;
      }
    } catch {
      // Nulls; rules fail closed.
    }
    return out;
  }

  /** Creator's current share of supply. */
  async devHoldPct(token, creator, meta) {
    try {
      const balance = await this.client.public.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [creator],
      });
      const supply = Number(meta.totalSupply);
      return supply > 0 ? (Number(balance) / supply) * 100 : null;
    } catch {
      return null;
    }
  }

  /** Pool depth: WETH side x2 (v3 pools are near-symmetric in value). */
  async poolStats(pool, ethUsd) {
    try {
      const wethBalance = await this.client.public.readContract({
        address: ADDRESSES.weth,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [pool],
      });
      const wethSide = Number(wethBalance) / 1e18;
      return { liquidityUsd: ethUsd ? wethSide * 2 * ethUsd : null };
    } catch {
      return null;
    }
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
