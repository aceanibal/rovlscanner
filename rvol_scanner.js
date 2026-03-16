// rvol_scanner.js
// Hyperliquid RVOL scanner with daily caching and file output

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const { DateTime } = require('luxon');

// --- Config ---

const INFO_BASE_URL = 'https://api.hyperliquid.xyz';
const REQUEST_TIMEOUT_MS = 10_000;
const CANDLE_INTERVAL = '1h';
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'hyperliquid_rvol.db');
const MIN_DAY_NTL_VLM = 10_000_000;
const MIN_OPEN_INTEREST = 0;

// Snapshot modes:
// - 'preopen': analytics snapshot using candles up to 9:00am ET (for 9–12pm prep/backtest)
// - 'live':    use candles up to the latest available bar at run time
const SNAPSHOT_MODE_PREOPEN = 'preopen';
const SNAPSHOT_MODE_LIVE = 'live';

// --- Helpers ---

// Compute the end timestamp (ms since epoch) for the candle snapshot,
// depending on snapshot mode.
function getSnapshotEndMs(tradingDate, snapshotMode) {
  if (snapshotMode === SNAPSHOT_MODE_PREOPEN) {
    // 9:00am ET on that trading date
    const dt = DateTime.fromISO(tradingDate, { zone: 'America/New_York' }).set({
      hour: 9,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    return dt.toMillis();
  }

  // Live mode: use current time
  return Date.now();
}

// 5 days before a given end timestamp (ms)
function getFiveDaysAgoMs(endTimeMs) {
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  return endTimeMs - fiveDaysMs;
}

// Simple sleep utility for rate-limiting
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return '0';
  // Show more precision for sub-dollar assets so they don't round to 0.00
  const fractionDigits = value < 1 ? 6 : 2;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatFundingPercent(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  const pct = value * 100;
  return `${pct.toFixed(4)}%`;
}

// Simple CLI option parsing
function parseCliOptions() {
  const args = process.argv.slice(2);
  const opts = {
    snapshotMode: SNAPSHOT_MODE_PREOPEN,
    forceRefresh: false,
  };

  for (const arg of args) {
    if (arg === '--force-refresh') {
      opts.forceRefresh = true;
    } else if (arg.startsWith('--snapshot-mode=')) {
      const v = arg.split('=')[1];
      if (v === SNAPSHOT_MODE_PREOPEN || v === SNAPSHOT_MODE_LIVE) {
        opts.snapshotMode = v;
      }
    }
  }

  return opts;
}

// --- HTTP client ---

const client = axios.create({
  baseURL: INFO_BASE_URL,
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});

// --- Meta fetching & parsing ---

/**
 * Fetches universe + asset context (markPx, OI, 24h volume, funding, etc.)
 * from Hyperliquid using the metaAndAssetCtxs info endpoint.
 */
async function fetchMetaAndAssetCtxs() {
  const body = {
    type: 'metaAndAssetCtxs',
  };

  const { data } = await client.post('/info', body);

  // The API may return either an object with { universe, assetCtxs }
  // or an array like [universePart, assetCtxsPart]. Normalize here.
  if (Array.isArray(data)) {
    const universePart = data[0] || {};
    const assetCtxsPart = data[1] || {};
    const universe = Array.isArray(universePart.universe)
      ? universePart.universe
      : Array.isArray(universePart)
      ? universePart
      : [];
    const assetCtxs = Array.isArray(assetCtxsPart.assetCtxs)
      ? assetCtxsPart.assetCtxs
      : Array.isArray(assetCtxsPart)
      ? assetCtxsPart
      : [];
    return { universe, assetCtxs, _raw: data };
  }

  return data;
}

/**
 * Extracts perpetual asset symbols from the meta response.
 * Uses the `name` field as the coin symbol and ignores delisted entries when flagged.
 */
function extractPerpAssets(meta) {
  const universe = Array.isArray(meta.universe) ? meta.universe : [];

  const assets = universe
    .filter((u) => u && u.name)
    .filter((u) => u.isDelisted !== true)
    .map((u) => u.name);

  return assets;
}

// --- Candle fetching & parsing ---

/**
 * Fetches 1h candles for a given coin from startTimeMs up to endTimeMs.
 * Returns an array of parsed, sorted candle objects.
 */
async function fetchCandles(coin, startTimeMs, endTimeMs) {
  const body = {
    type: 'candleSnapshot',
    req: {
      coin,
      interval: CANDLE_INTERVAL,
      startTime: startTimeMs,
      endTime: endTimeMs,
    },
  };

  const { data } = await client.post('/info', body);

  if (!Array.isArray(data)) {
    throw new Error(
      `Unexpected candleSnapshot response for ${coin}: ${JSON.stringify(data).slice(0, 200)}`
    );
  }

  const candles = data.map((c) => ({
    openTime: c.t,
    closeTime: c.T,
    symbol: c.s,
    interval: c.i,
    open: parseFloat(c.o),
    close: parseFloat(c.c),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    volume: parseFloat(c.v),
    trades: c.n,
  }));

  candles.sort((a, b) => a.openTime - b.openTime);

  return candles;
}

// --- Volume and RVOL calculations ---

function computeDollarVolume(candles) {
  return candles.reduce((sum, c) => {
    if (!Number.isFinite(c.volume) || !Number.isFinite(c.close)) return sum;
    return sum + c.volume * c.close;
  }, 0);
}

/**
 * Given all candles for an asset (sorted ascending by time), compute:
 * - current 12h dollar volume (last 12 candles)
 * - baseline average 12h dollar volume over previous 5 days (non-overlapping 12-candle chunks)
 */
function computeCurrentAndBaselineVolumes(allCandles) {
  if (!Array.isArray(allCandles) || allCandles.length < 24) {
    return null;
  }

  const candles = [...allCandles].sort((a, b) => a.openTime - b.openTime);

  const total = candles.length;
  const currentWindow = candles.slice(total - 12, total);
  const historical = candles.slice(0, total - 12);

  if (historical.length < 12) {
    return null;
  }

  const historicalChunks = chunkArray(historical, 12).filter((chunk) => chunk.length === 12);
  if (historicalChunks.length === 0) {
    return null;
  }

  const currentDollarVol = computeDollarVolume(currentWindow);

  const historicalVolumes = historicalChunks.map((chunk) => computeDollarVolume(chunk));
  const baseline =
    historicalVolumes.reduce((sum, v) => sum + v, 0) / historicalVolumes.length;

  if (!Number.isFinite(baseline) || baseline <= 0) {
    return null;
  }

  return {
    currentDollarVol,
    baselineDollarVol: baseline,
  };
}

function computeAssetStats(symbol, candles) {
  const volumes = computeCurrentAndBaselineVolumes(candles);
  if (!volumes) return null;

  const latest = candles[candles.length - 1];
  const price = latest.close;

  const rvol = volumes.currentDollarVol / volumes.baselineDollarVol;

  if (!Number.isFinite(rvol)) {
    return null;
  }

  return {
    asset: symbol,
    rvol,
    current12hVolumeUsd: volumes.currentDollarVol,
    price,
  };
}

// --- BTC correlation helpers ---

function computeReturnSeries(candles) {
  const series = [];
  if (!Array.isArray(candles) || candles.length < 2) return series;

  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    if (!Number.isFinite(prev.close) || !Number.isFinite(curr.close) || prev.close <= 0) {
      continue;
    }
    const ret = Math.log(curr.close / prev.close);
    series.push({ time: curr.closeTime, ret });
  }
  return series;
}

function computePearsonCorrelation(x, y) {
  const n = x.length;
  if (n === 0 || y.length !== n) return null;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    sumX += xi;
    sumY += yi;
    sumXY += xi * yi;
    sumX2 += xi * xi;
    sumY2 += yi * yi;
  }

  const numerator = n * sumXY - sumX * sumY;
  const denomPartX = n * sumX2 - sumX * sumX;
  const denomPartY = n * sumY2 - sumY * sumY;
  if (denomPartX <= 0 || denomPartY <= 0) return null;

  const denominator = Math.sqrt(denomPartX * denomPartY);
  if (denominator === 0) return null;

  return numerator / denominator;
}

function computeBtcCorrelation(assetCandles, btcCandles) {
  const assetReturns = computeReturnSeries(assetCandles);
  const btcReturns = computeReturnSeries(btcCandles);
  if (assetReturns.length === 0 || btcReturns.length === 0) return null;

  const btcMap = new Map();
  for (const r of btcReturns) {
    btcMap.set(r.time, r.ret);
  }

  const assetVals = [];
  const btcVals = [];
  for (const r of assetReturns) {
    if (btcMap.has(r.time)) {
      assetVals.push(r.ret);
      btcVals.push(btcMap.get(r.time));
    }
  }

  if (assetVals.length < 12) {
    return null;
  }

  return computePearsonCorrelation(assetVals, btcVals);
}

// --- SQLite caching ---

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function openDatabase() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trading_date TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      results_json TEXT NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS asset_ctx_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trading_date TEXT NOT NULL,
      coin TEXT NOT NULL,
      mark_px REAL,
      open_interest REAL,
      day_ntl_vlm REAL,
      funding REAL,
      oracle_px REAL,
      mid_px REAL,
      prev_day_px REAL,
      premium REAL,
      impact_px_buy REAL,
      impact_px_sell REAL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_asset_ctx_snapshots_date_coin
      ON asset_ctx_snapshots(trading_date, coin);
  `);
  return db;
}

function makeTradingKey(tradingDate, snapshotMode) {
  return `${tradingDate}:${snapshotMode}`;
}

function getCachedRun(db, tradingKey) {
  const stmt = db.prepare(
    'SELECT trading_date, created_at, results_json FROM runs WHERE trading_date = ? LIMIT 1'
  );
  const row = stmt.get(tradingKey);
  if (!row) return null;
  try {
    const results = JSON.parse(row.results_json);
    return { tradingDate: row.trading_date, createdAt: row.created_at, results };
  } catch (e) {
    console.warn('Failed to parse cached results_json, ignoring cache:', e.message || e);
    return null;
  }
}

function saveRun(db, tradingKey, results) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO runs (trading_date, created_at, results_json) VALUES (?, ?, ?)'
  );
  const createdAt = Date.now();
  const resultsJson = JSON.stringify(results);
  stmt.run(tradingKey, createdAt, resultsJson);
}

function saveAssetCtxSnapshots(db, tradingKey, assetCtxs, universe) {
  if (!assetCtxs || !Array.isArray(assetCtxs) || !Array.isArray(universe)) {
    return;
  }

  const createdAt = Date.now();
  const insertStmt = db.prepare(
    `
      INSERT INTO asset_ctx_snapshots (
        trading_date,
        coin,
        mark_px,
        open_interest,
        day_ntl_vlm,
        funding,
        oracle_px,
        mid_px,
        prev_day_px,
        premium,
        impact_px_buy,
        impact_px_sell,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  const deleteStmt = db.prepare('DELETE FROM asset_ctx_snapshots WHERE trading_date = ?');

  const tx = db.transaction(() => {
    deleteStmt.run(tradingKey);

    for (let i = 0; i < assetCtxs.length; i++) {
      const ctx = assetCtxs[i];
      const meta = universe[i];
      if (!meta || !meta.name || meta.isDelisted === true || !ctx) {
        continue;
      }

      const coin = meta.name;

      const markPx = ctx.markPx != null ? parseFloat(ctx.markPx) : null;
      const openInterest = ctx.openInterest != null ? parseFloat(ctx.openInterest) : null;
      const dayNtlVlm = ctx.dayNtlVlm != null ? parseFloat(ctx.dayNtlVlm) : null;
      const funding = ctx.funding != null ? parseFloat(ctx.funding) : null;
      const oraclePx = ctx.oraclePx != null ? parseFloat(ctx.oraclePx) : null;
      const midPx = ctx.midPx != null ? parseFloat(ctx.midPx) : null;
      const prevDayPx = ctx.prevDayPx != null ? parseFloat(ctx.prevDayPx) : null;
      const premium = ctx.premium != null ? parseFloat(ctx.premium) : null;

      let impactBuy = null;
      let impactSell = null;
      if (Array.isArray(ctx.impactPxs) && ctx.impactPxs.length >= 2) {
        impactBuy =
          ctx.impactPxs[0] != null && ctx.impactPxs[0] !== ''
            ? parseFloat(ctx.impactPxs[0])
            : null;
        impactSell =
          ctx.impactPxs[1] != null && ctx.impactPxs[1] !== ''
            ? parseFloat(ctx.impactPxs[1])
            : null;
      }

      insertStmt.run(
        tradingKey,
        coin,
        Number.isFinite(markPx) ? markPx : null,
        Number.isFinite(openInterest) ? openInterest : null,
        Number.isFinite(dayNtlVlm) ? dayNtlVlm : null,
        Number.isFinite(funding) ? funding : null,
        Number.isFinite(oraclePx) ? oraclePx : null,
        Number.isFinite(midPx) ? midPx : null,
        Number.isFinite(prevDayPx) ? prevDayPx : null,
        Number.isFinite(premium) ? premium : null,
        Number.isFinite(impactBuy) ? impactBuy : null,
        Number.isFinite(impactSell) ? impactSell : null,
        createdAt
      );
    }
  });

  tx();
}

function saveReport(db, tradingDate, snapshotMode, results) {
  if (!db || !results || !Array.isArray(results) || results.length === 0) {
    return;
  }

  const deleteStmt = db.prepare(
    'DELETE FROM report WHERE trading_date = ? AND snapshot_mode = ?'
  );

  const insertStmt = db.prepare(
    `
      INSERT INTO report (
        trading_date,
        snapshot_mode,
        asset,
        rvol,
        current_12h_volume_usd,
        day_ntl_vlm,
        open_interest,
        oi_24h_vol_ratio,
        funding,
        price,
        btc_corr,
        run_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  const tx = db.transaction(() => {
    deleteStmt.run(tradingDate, snapshotMode);

    for (const r of results) {
      let oiVolRatio = null;
      if (
        Number.isFinite(r.openInterest) &&
        Number.isFinite(r.dayNtlVlm) &&
        r.dayNtlVlm > 0
      ) {
        oiVolRatio = r.openInterest / r.dayNtlVlm;
      }

      insertStmt.run(
        tradingDate,
        snapshotMode,
        r.asset,
        r.rvol,
        Number.isFinite(r.current12hVolumeUsd) ? r.current12hVolumeUsd : null,
        Number.isFinite(r.dayNtlVlm) ? r.dayNtlVlm : null,
        Number.isFinite(r.openInterest) ? r.openInterest : null,
        Number.isFinite(oiVolRatio) ? oiVolRatio : null,
        Number.isFinite(r.funding) ? r.funding : null,
        Number.isFinite(r.price) ? r.price : null,
        Number.isFinite(r.btcCorr) ? r.btcCorr : null,
        Number.isFinite(r.runTimestamp) ? r.runTimestamp : Date.now()
      );
    }
  });

  tx();
}

// --- JSON results file ---

function writeResultsFile(tradingDate, snapshotMode, results) {
  ensureDataDir();
  const modeSuffix = snapshotMode === SNAPSHOT_MODE_LIVE ? 'live' : 'preopen';
  const filePath = path.join(DATA_DIR, `rvol_results_${tradingDate}_${modeSuffix}.json`);
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Wrote results file: ${filePath}`);
}

// --- Asset context loading and market filters ---

function loadAssetCtxByDate(db, tradingKey) {
  const stmt = db.prepare(
    `
      SELECT coin,
             mark_px,
             open_interest,
             day_ntl_vlm,
             funding,
             oracle_px,
             mid_px,
             prev_day_px,
             premium,
             impact_px_buy,
             impact_px_sell
      FROM asset_ctx_snapshots
      WHERE trading_date = ?
    `
  );

  const rows = stmt.all(tradingKey);
  const map = new Map();
  for (const row of rows) {
    map.set(row.coin, {
      markPx: row.mark_px,
      openInterest: row.open_interest,
      dayNtlVlm: row.day_ntl_vlm,
      funding: row.funding,
      oraclePx: row.oracle_px,
      midPx: row.mid_px,
      prevDayPx: row.prev_day_px,
      premium: row.premium,
      impactPxBuy: row.impact_px_buy,
      impactPxSell: row.impact_px_sell,
    });
  }
  return map;
}

function applyMarketContextToResults(results, ctxMap) {
  if (!results || !Array.isArray(results) || !ctxMap) return results || [];

  return results.map((r) => {
    const ctx = ctxMap.get(r.asset);
    if (!ctx) return r;
    return {
      ...r,
      dayNtlVlm: ctx.dayNtlVlm,
      openInterest: ctx.openInterest,
      funding: ctx.funding,
      markPx: ctx.markPx,
    };
  });
}

function filterByMarketContext(results) {
  if (!results || !Array.isArray(results)) return [];
  const filtered = results.filter((r) => {
    if (!Number.isFinite(r.dayNtlVlm) || r.dayNtlVlm < MIN_DAY_NTL_VLM) {
      return false;
    }
    if (Number.isFinite(MIN_OPEN_INTEREST) && MIN_OPEN_INTEREST > 0) {
      if (!Number.isFinite(r.openInterest) || r.openInterest < MIN_OPEN_INTEREST) {
        return false;
      }
    }
    return true;
  });
  return filtered;
}

// --- Main RVOL scan logic ---

async function performFreshScan(tradingDate, tradingKey, snapshotMode, db) {
  console.log(`No cache for trading date ${tradingDate}, fetching data from Hyperliquid...`);

  console.log('Fetching meta + asset context (markPx, OI, 24h volume, funding)...');
  const metaAndCtx = await fetchMetaAndAssetCtxs();

  try {
    if (metaAndCtx && metaAndCtx._raw && Array.isArray(metaAndCtx._raw)) {
      console.log(
        'metaAndAssetCtxs returned array form. universe length:',
        Array.isArray(metaAndCtx.universe) ? metaAndCtx.universe.length : 'n/a',
        'assetCtxs length:',
        Array.isArray(metaAndCtx.assetCtxs) ? metaAndCtx.assetCtxs.length : 'n/a'
      );
      console.log(
        'Sample universe entries:',
        Array.isArray(metaAndCtx.universe)
          ? JSON.stringify(metaAndCtx.universe.slice(0, 3))
          : 'n/a'
      );
      console.log(
        'Sample assetCtx entries:',
        Array.isArray(metaAndCtx.assetCtxs)
          ? JSON.stringify(metaAndCtx.assetCtxs.slice(0, 3))
          : 'n/a'
      );
    }
  } catch (e) {
    console.warn('Failed to log metaAndAssetCtxs debug info:', e.message || e);
  }

  const assets = extractPerpAssets(metaAndCtx);
  console.log(`Total assets in universe (filtered): ${assets.length}`);

  if (db && metaAndCtx && Array.isArray(metaAndCtx.assetCtxs)) {
    try {
      saveAssetCtxSnapshots(db, tradingKey, metaAndCtx.assetCtxs, metaAndCtx.universe || []);
      console.log(
        `Saved ${metaAndCtx.assetCtxs.length} asset context snapshots for trading date ${tradingDate} into SQLite.`
      );
    } catch (e) {
      console.warn(
        'Failed to persist asset context snapshots to SQLite (continuing without DB write):',
        e.message || e
      );
    }
  }

  if (assets.length === 0) {
    throw new Error('No assets found in universe.');
  }

  const snapshotEndMs = getSnapshotEndMs(tradingDate, snapshotMode);
  const startTimeMs = getFiveDaysAgoMs(snapshotEndMs);
  const results = [];
  let btcCandles = null;

  // Ensure BTC is processed first so correlation is available for others
  const btcIndex = assets.indexOf('BTC');
  if (btcIndex > 0) {
    const [btc] = assets.splice(btcIndex, 1);
    assets.unshift(btc);
  }

  for (let i = 0; i < assets.length; i++) {
    const coin = assets[i];
    console.log(`Processing ${coin} (${i + 1}/${assets.length})`);

    try {
      const candles = await fetchCandles(coin, startTimeMs, snapshotEndMs);

      if (!candles || candles.length < 24) {
        console.log(`Skipping ${coin}: not enough candles (${candles.length}).`);
      } else {
        if (coin === 'BTC') {
          btcCandles = candles;
        }

        const stats = computeAssetStats(coin, candles);
        if (stats) {
          let btcCorr = null;
          if (btcCandles && coin !== 'BTC') {
            btcCorr = computeBtcCorrelation(candles, btcCandles);
          } else if (coin === 'BTC') {
            btcCorr = 1; // Perfect self-correlation
          }

          results.push({
            ...stats,
            btcCorr,
            runDate: tradingDate,
            runTimestamp: Date.now(),
          });
        } else {
          console.log(`Skipping ${coin}: could not compute RVOL.`);
        }
      }
    } catch (err) {
      console.error(`Error processing ${coin}:`, err.message || err);
    }

    await sleep(50);
  }

  results.sort((a, b) => b.rvol - a.rvol);

  return results;
}

function printResultsTable(results, tradingDate) {
  if (!results || results.length === 0) {
    console.log('No RVOL results to display.');
    return;
  }

  const table = results.map((r) => {
    let oiVolRatio = 'n/a';
    if (Number.isFinite(r.openInterest) && Number.isFinite(r.dayNtlVlm) && r.dayNtlVlm > 0) {
      const ratio = r.openInterest / r.dayNtlVlm;
      oiVolRatio = ratio.toFixed(2);
    }

    return {
      Asset: r.asset,
      RVOL: r.rvol.toFixed(2),
      '12h Volume ($)': formatUsd(r.current12hVolumeUsd),
      '24h Ntl Vol ($)': Number.isFinite(r.dayNtlVlm) ? formatUsd(r.dayNtlVlm) : 'n/a',
      'OI ($)': Number.isFinite(r.openInterest) ? formatUsd(r.openInterest) : 'n/a',
      'OI/24h Vol': oiVolRatio,
      Funding: formatFundingPercent(r.funding),
      Price: formatPrice(r.price),
      'BTC Corr': r.btcCorr != null && Number.isFinite(r.btcCorr) ? r.btcCorr.toFixed(2) : 'n/a',
    };
  });

  console.log(`\n=== RVOL Results for ${tradingDate} ===`);
  console.table(table);

  const top = results[0];
  console.log(
    `\nTop Asset in Play: ${top.asset} | RVOL: ${top.rvol.toFixed(
      2
    )} | 12h Vol: $${formatUsd(top.current12hVolumeUsd)} | 24h Ntl Vol: $${
      Number.isFinite(top.dayNtlVlm) ? formatUsd(top.dayNtlVlm) : 'n/a'
    } | OI: $${
      Number.isFinite(top.openInterest) ? formatUsd(top.openInterest) : 'n/a'
    } | Funding: ${formatFundingPercent(top.funding)} | Price: $${formatPrice(
      top.price
    )} | BTC Corr: ${
      top.btcCorr != null && Number.isFinite(top.btcCorr) ? top.btcCorr.toFixed(2) : 'n/a'
    } | Date: ${tradingDate}`
  );
}

async function run() {
  console.log('=== Hyperliquid RVOL Scanner ===');

  const nowEt = DateTime.now().setZone('America/New_York');
  const tradingDate = nowEt.toISODate();
  console.log(`Current ET time: ${nowEt.toISO()} | Trading date: ${tradingDate}`);

  const options = parseCliOptions();
  if (options.forceRefresh) {
    console.log('Force refresh enabled: ignoring any cached runs for today.');
  }

  console.log(
    `Snapshot mode: ${
      options.snapshotMode === SNAPSHOT_MODE_PREOPEN ? 'preopen (9:00am ET snapshot)' : 'live'
    }`
  );

  ensureDataDir();
  const db = openDatabase();

  try {
    let results;

    const tradingKey = makeTradingKey(tradingDate, options.snapshotMode);
    const cached = options.forceRefresh ? null : getCachedRun(db, tradingKey);

    if (cached) {
      console.log(
        `Using cached results for trading key ${tradingKey} (created at ${new Date(
          cached.createdAt
        ).toISOString()})`
      );
      results = cached.results;
    } else {
      results = await performFreshScan(tradingDate, tradingKey, options.snapshotMode, db);
      saveRun(db, tradingKey, results);
      writeResultsFile(tradingDate, options.snapshotMode, results);
    }

    // Load market context for this trading date and apply filters
    const ctxMap = loadAssetCtxByDate(db, tradingKey);
    const withCtx = applyMarketContextToResults(results, ctxMap);
    const finalResults = filterByMarketContext(withCtx);

    saveReport(db, tradingDate, options.snapshotMode, finalResults);

    console.log(
      `Applied market context filters:\n` +
        `- 24h notional volume >= ${formatUsd(
          MIN_DAY_NTL_VLM
        )}$ (drops illiquid / dead markets).\n` +
        (MIN_OPEN_INTEREST > 0
          ? `- Open interest >= ${formatUsd(
              MIN_OPEN_INTEREST
            )}$ (requires minimum open positions).\n`
          : '') +
        `Displayed columns: RVOL (12h vs 5d baseline), 12h notional volume, 24h notional volume, open interest, OI/24h volume ratio, funding %, price, BTC correlation.`
    );

    printResultsTable(finalResults, tradingDate);
  } catch (err) {
    console.error('Fatal error in RVOL scanner:', err.message || err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  run();
}

module.exports = {
  fetchMetaAndAssetCtxs,
  extractPerpAssets,
  fetchCandles,
  sleep,
  computeCurrentAndBaselineVolumes,
  computeAssetStats,
};


