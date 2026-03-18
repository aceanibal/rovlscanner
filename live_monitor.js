// live_monitor.js
// Live monitoring of top RVOL assets using Hyperliquid WebSocket L2 book and trades.

const Database = require('better-sqlite3');
const WebSocket = require('ws');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'hyperliquid_rvol.db');

const WS_URL = 'wss://api.hyperliquid.xyz/ws';

// Configurable parameters
const SNAPSHOT_MODE = 'preopen'; // or 'live'

// Spread/depth thresholds
const MAX_SPREAD_PCT = 0.1; // 0.1%
const DEPTH_PCT = 1; // +-1% around mid price

// Trade delta window (in ms)
const TRADE_WINDOW_MS = 60 * 1000; // 1 minute
const MID_HISTORY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes
const RETURN_30S_MS = 30 * 1000;
const RETURN_120S_MS = 120 * 1000;

function openDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  // Ensure the report table exists (in case rvol_scanner hasn't been run since this table was added)
  db.exec(`
    CREATE TABLE IF NOT EXISTS report (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trading_date TEXT NOT NULL,
      snapshot_mode TEXT NOT NULL,
      asset TEXT NOT NULL,
      rvol REAL NOT NULL,
      current_12h_volume_usd REAL,
      day_ntl_vlm REAL,
      open_interest REAL,
      oi_24h_vol_ratio REAL,
      funding REAL,
      price REAL,
      btc_corr REAL,
      run_timestamp INTEGER NOT NULL
    );
  `);
  return db;
}

function getLatestReportAssets(db) {
  // Get the latest trading_date for the chosen snapshot_mode
  const row = db
    .prepare(
      `
      SELECT trading_date
      FROM report
      WHERE snapshot_mode = ?
      ORDER BY trading_date DESC
      LIMIT 1
    `
    )
    .get(SNAPSHOT_MODE);

  if (!row) {
    console.log('No report rows found for snapshot mode:', SNAPSHOT_MODE);
    return [];
  }

  const tradingDate = row.trading_date;

  const assets = db
    .prepare(
      `
      SELECT asset, rvol
      FROM report
      WHERE snapshot_mode = ?
        AND trading_date = ?
      ORDER BY rvol DESC
    `
    )
    .all(SNAPSHOT_MODE, tradingDate);

  console.log(
    `Monitoring all ${assets.length} assets from report for trading_date=${tradingDate}, snapshot_mode=${SNAPSHOT_MODE}`
  );

  return assets.map((a) => a.asset);
}

function createWsConnection(coins) {
  if (!coins || coins.length === 0) {
    console.log('No coins to monitor. Exiting.');
    process.exit(0);
  }

  console.log(`Subscribing to ${coins.length} coins from latest report.`);
  console.log('Coins:', coins.join(', '));

  const state = createEmptyState();

  const ws = new WebSocket(WS_URL);
  let debugMsgCount = 0;

  ws.on('open', () => {
    console.log('WebSocket connected to Hyperliquid.');

    for (const coin of coins) {
      const subMsg = {
        method: 'subscribe',
        subscription: {
          type: 'l2Book',
          coin,
        },
      };
      ws.send(JSON.stringify(subMsg));

      const tradesMsg = {
        method: 'subscribe',
        subscription: {
          type: 'trades',
          coin,
        },
      };
      ws.send(JSON.stringify(tradesMsg));
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Log a few raw messages to understand payload shape
      if (debugMsgCount < 5) {
        console.log('WS raw message:', JSON.stringify(msg).slice(0, 400));
        debugMsgCount += 1;
      }

      handleChannelMessage(state, msg);
    } catch (e) {
      console.error('Failed to parse WS message:', e.message || e);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message || err);
  });

  ws.on('close', (code, reason) => {
    console.log('WebSocket closed:', code, reason?.toString());
  });

  // Periodically print current metrics
  setInterval(() => {
    const rows = buildLiveRows(state);
    printLiveMetricsFromRows(rows);
  }, 5000);
}

function createEmptyState() {
  return {
    books: new Map(), // coin -> { bids: [[px, qty], ...], asks: [[px, qty], ...] }
    trades: new Map(), // coin -> [{ side, px, sz, ts }, ...]
    mids: new Map(), // coin -> [{ ts, mid }, ...]
  };
}

function pruneByTime(items, cutoffTs) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.filter((x) => Number.isFinite(x.ts) && x.ts >= cutoffTs);
}

function upsertMidPoint(state, coin, mid, ts) {
  if (!Number.isFinite(mid) || !Number.isFinite(ts)) return;
  const nowTs = Date.now();
  const cutoff = nowTs - MID_HISTORY_WINDOW_MS;

  let arr = state.mids.get(coin);
  if (!arr) {
    arr = [];
    state.mids.set(coin, arr);
  }

  arr.push({ ts, mid });
  state.mids.set(coin, pruneByTime(arr, cutoff));
}

function findLatestMidAtOrBefore(midSeries, targetTs) {
  if (!Array.isArray(midSeries) || midSeries.length === 0) return null;
  for (let i = midSeries.length - 1; i >= 0; i--) {
    const p = midSeries[i];
    if (p.ts <= targetTs && Number.isFinite(p.mid) && p.mid > 0) {
      return p.mid;
    }
  }
  return null;
}

function computeReturnPct(midSeries, windowMs, nowTs) {
  if (!Array.isArray(midSeries) || midSeries.length === 0) return null;
  const latest = midSeries[midSeries.length - 1];
  if (!latest || !Number.isFinite(latest.mid) || latest.mid <= 0) return null;

  const pastMid = findLatestMidAtOrBefore(midSeries, nowTs - windowMs);
  if (!Number.isFinite(pastMid) || pastMid <= 0) return null;

  return ((latest.mid - pastMid) / pastMid) * 100;
}

function handleChannelMessage(state, msg) {
  const channel = msg.channel;

  // Hyperliquid l2Book shape:
  // { channel: "l2Book", data: { coin, time, levels: [bids[], asks[]] } }
  if (channel === 'l2Book') {
    const data = msg.data;
    if (!data || !data.coin || !Array.isArray(data.levels) || data.levels.length < 2) return;

    const coin = data.coin;
    const [rawBids, rawAsks] = data.levels;
    const ts = typeof data.time === 'number' ? data.time : Date.now();

    if (!Array.isArray(rawBids) || !Array.isArray(rawAsks)) return;

    // Convert [{ px, sz, n }, ...] → [[px, sz], ...] as numbers
    const bids = rawBids
      .map((l) => [parseFloat(l.px), parseFloat(l.sz)])
      .filter(([px, sz]) => Number.isFinite(px) && Number.isFinite(sz));

    const asks = rawAsks
      .map((l) => [parseFloat(l.px), parseFloat(l.sz)])
      .filter(([px, sz]) => Number.isFinite(px) && Number.isFinite(sz));

    if (bids.length === 0 || asks.length === 0) return;

    state.books.set(coin, { bids, asks });

    const bestBid = bids[0][0];
    const bestAsk = asks[0][0];
    if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid > 0 && bestAsk > 0) {
      const mid = (bestBid + bestAsk) / 2;
      upsertMidPoint(state, coin, mid, ts);
    }
  }

  // Hyperliquid trades shape:
  // { channel: "trades", data: [ { coin, side, px, sz, time, ... }, ... ] }
  if (channel === 'trades') {
    const data = msg.data;
    if (!Array.isArray(data)) return;

    const nowTs = Date.now();

    for (const t of data) {
      const coin = t.coin;
      if (!coin) continue;

      let arr = state.trades.get(coin);
      if (!arr) {
        arr = [];
        state.trades.set(coin, arr);
      }

      // Try to adapt to multiple possible trade shapes
      const side = (t.s || t.side || t.direction || '').toString().toUpperCase();
      const px = parseFloat(t.px ?? t.p ?? t.price);
      const sz = parseFloat(t.sz ?? t.q ?? t.size);
      const ts =
        typeof t.time === 'number'
          ? t.time
          : typeof t.ts === 'number'
          ? t.ts
          : typeof t.timestamp === 'number'
          ? t.timestamp
          : nowTs;

      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;

      arr.push({ side, px, sz, ts });
    }

    const now = Date.now();
    const cutoff = nowTs - TRADE_WINDOW_MS;

    for (const [coin, arr] of state.trades.entries()) {
      state.trades.set(coin, arr.filter((t) => t.ts >= cutoff));
    }
  }
}

function computeSpreadAndDepth(book) {
  if (!book) return null;
  const { bids, asks } = book;
  if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
    return null;
  }

  const bestBid = parseFloat(bids[0][0]);
  const bestAsk = parseFloat(asks[0][0]);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
    return null;
  }

  const mid = (bestBid + bestAsk) / 2;
  const spreadAbs = bestAsk - bestBid;
  const spreadPct = (spreadAbs / mid) * 100;

  const lower = mid * (1 - DEPTH_PCT / 100);
  const upper = mid * (1 + DEPTH_PCT / 100);

  let bidDepth = 0;
  let askDepth = 0;

  for (const [pxRaw, szRaw] of bids) {
    const px = parseFloat(pxRaw);
    const sz = parseFloat(szRaw);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    if (px >= lower) {
      bidDepth += px * sz;
    } else {
      break;
    }
  }

  for (const [pxRaw, szRaw] of asks) {
    const px = parseFloat(pxRaw);
    const sz = parseFloat(szRaw);
    if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
    if (px <= upper) {
      askDepth += px * sz;
    } else {
      break;
    }
  }

  return {
    bestBid,
    bestAsk,
    mid,
    spreadPct,
    bidDepth,
    askDepth,
  };
}

function computeTradeDelta(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { buyNotional: 0, sellNotional: 0, delta: 0, imbalancePct: 0 };
  }

  let buyNotional = 0;
  let sellNotional = 0;

  for (const t of trades) {
    if (!Number.isFinite(t.px) || !Number.isFinite(t.sz)) continue;
    const notional = t.px * t.sz;
    const side = (t.side || '').toUpperCase();
    if (side === 'B') {
      buyNotional += notional;
    } else if (side === 'S') {
      sellNotional += notional;
    }
  }

  const delta = buyNotional - sellNotional;
  const total = buyNotional + sellNotional;
  const imbalancePct = total > 0 ? (delta / total) * 100 : 0;

  return { buyNotional, sellNotional, delta, imbalancePct };
}

function buildLiveRows(state) {
  const rows = [];
  const nowTs = Date.now();

  for (const [coin, book] of state.books.entries()) {
    const spreadDepth = computeSpreadAndDepth(book);
    if (!spreadDepth) {
      continue;
    }

    const trades = state.trades.get(coin) || [];
    const deltaStats = computeTradeDelta(trades);

    const isSpreadOk = spreadDepth.spreadPct <= MAX_SPREAD_PCT;
    const isDirectionStrong = Math.abs(deltaStats.imbalancePct) >= 20; // configurable

    const totalDepth = spreadDepth.bidDepth + spreadDepth.askDepth;
    const mids = state.mids.get(coin) || [];
    const ret30sPct = computeReturnPct(mids, RETURN_30S_MS, nowTs);
    const ret120sPct = computeReturnPct(mids, RETURN_120S_MS, nowTs);
    const absMovePct =
      Number.isFinite(ret30sPct) || Number.isFinite(ret120sPct)
        ? (Math.abs(ret30sPct || 0) + Math.abs(ret120sPct || 0)) / 2
        : 0;

    // Ranking score combines:
    // - order flow / liquidity
    // - short-term movement (30s and 120s)
    // - spread penalty so wide markets are de-prioritized
    const flowScore = Math.abs(deltaStats.imbalancePct) * Math.log10(1 + totalDepth / 100_000);
    const movementScore = 0.7 * Math.abs(ret30sPct || 0) + 0.3 * Math.abs(ret120sPct || 0);
    const spreadPenalty = Math.max(0, 1 - spreadDepth.spreadPct / 0.2);
    const score = spreadPenalty * (0.6 * flowScore + 0.4 * movementScore * 100);

    rows.push({
      coin,
      spreadPct: spreadDepth.spreadPct,
      bidDepth: spreadDepth.bidDepth,
      askDepth: spreadDepth.askDepth,
      totalDepth,
      delta: deltaStats.delta,
      imbalancePct: deltaStats.imbalancePct,
      ret30sPct: Number.isFinite(ret30sPct) ? ret30sPct : null,
      ret120sPct: Number.isFinite(ret120sPct) ? ret120sPct : null,
      absMovePct,
      isSpreadOk,
      isDirectionStrong,
      score,
    });
  }

  rows.sort((a, b) => b.score - a.score);

  return rows;
}

function printLiveMetricsFromRows(rows) {
  const now = new Date().toISOString();
  console.log(`\n=== Live monitor @ ${now} ===`);

  if (!rows || rows.length === 0) {
    console.log('No book data yet.');
    return;
  }

  console.table(
    rows.map((r) => ({
      Coin: r.coin,
      'Score': r.score.toFixed(2),
      'Spread %': r.spreadPct.toFixed(3),
      [`Depth ±${DEPTH_PCT}% ($)`]: r.totalDepth.toFixed(0),
      'Delta ($)': r.delta.toFixed(0),
      'Imbalance %': r.imbalancePct.toFixed(1),
      'Move 30s %': Number.isFinite(r.ret30sPct) ? r.ret30sPct.toFixed(2) : 'n/a',
      'Move 120s %': Number.isFinite(r.ret120sPct) ? r.ret120sPct.toFixed(2) : 'n/a',
      'Tight Spread': r.isSpreadOk,
      'Directional': r.isDirectionStrong,
    }))
  );

  const top = rows[0];
  console.log(
    `Top live candidate: ${top.coin} | score=${top.score.toFixed(
      2
    )} | spread=${top.spreadPct.toFixed(3)}% | depth±${DEPTH_PCT}%=$${top.totalDepth.toFixed(
      0
    )} | delta=$${top.delta.toFixed(0)} | imbalance=${top.imbalancePct.toFixed(
      1
    )}% | move30s=${Number.isFinite(top.ret30sPct) ? top.ret30sPct.toFixed(2) : 'n/a'}% | move120s=${
      Number.isFinite(top.ret120sPct) ? top.ret120sPct.toFixed(2) : 'n/a'
    }%`
  );
}

function main() {
  const db = openDatabase();
  try {
    const assets = getLatestReportAssets(db);
    createWsConnection(assets);
  } finally {
    // keep DB open only for initial read
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getLatestReportAssets,
  computeSpreadAndDepth,
  computeTradeDelta,
  createEmptyState,
  handleChannelMessage,
  buildLiveRows,
};

