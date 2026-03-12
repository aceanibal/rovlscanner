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

// --- Helpers ---

// 5 days ago in ms
function getFiveDaysAgoMs() {
  const now = Date.now();
  const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
  return now - fiveDaysMs;
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
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Simple CLI option parsing for BTC correlation filter
function parseCliOptions() {
  const args = process.argv.slice(2);
  const opts = {
    btcCorrMin: null,
    btcCorrMax: null,
    forceRefresh: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--btc-corr-min=')) {
      const v = parseFloat(arg.split('=')[1]);
      if (Number.isFinite(v)) opts.btcCorrMin = v;
    } else if (arg.startsWith('--btc-corr-max=')) {
      const v = parseFloat(arg.split('=')[1]);
      if (Number.isFinite(v)) opts.btcCorrMax = v;
    } else if (arg === '--force-refresh') {
      opts.forceRefresh = true;
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
 * Fetches raw meta response from Hyperliquid.
 */
async function fetchMeta() {
  const body = {
    type: 'meta',
    dex: '',
  };

  const { data } = await client.post('/info', body);
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
 * Fetches 1h candles for a given coin from startTimeMs up to now.
 * Returns an array of parsed, sorted candle objects.
 */
async function fetchCandles(coin, startTimeMs) {
  const body = {
    type: 'candleSnapshot',
    req: {
      coin,
      interval: CANDLE_INTERVAL,
      startTime: startTimeMs,
      endTime: null,
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
  `);
  return db;
}

function getCachedRun(db, tradingDate) {
  const stmt = db.prepare(
    'SELECT trading_date, created_at, results_json FROM runs WHERE trading_date = ? LIMIT 1'
  );
  const row = stmt.get(tradingDate);
  if (!row) return null;
  try {
    const results = JSON.parse(row.results_json);
    return { tradingDate: row.trading_date, createdAt: row.created_at, results };
  } catch (e) {
    console.warn('Failed to parse cached results_json, ignoring cache:', e.message || e);
    return null;
  }
}

function saveRun(db, tradingDate, results) {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO runs (trading_date, created_at, results_json) VALUES (?, ?, ?)'
  );
  const createdAt = Date.now();
  const resultsJson = JSON.stringify(results);
  stmt.run(tradingDate, createdAt, resultsJson);
}

// --- JSON results file ---

function writeResultsFile(tradingDate, results) {
  ensureDataDir();
  const filePath = path.join(DATA_DIR, `rvol_results_${tradingDate}.json`);
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Wrote results file: ${filePath}`);
}

// --- Main RVOL scan logic ---

async function performFreshScan(tradingDate, btcCorrMin, btcCorrMax) {
  console.log(`No cache for trading date ${tradingDate}, fetching data from Hyperliquid...`);

  console.log('Fetching meta...');
  const meta = await fetchMeta();
  const assets = extractPerpAssets(meta);
  console.log(`Total assets in universe (filtered): ${assets.length}`);

  if (assets.length === 0) {
    throw new Error('No assets found in universe.');
  }

  const startTimeMs = getFiveDaysAgoMs();
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
      const candles = await fetchCandles(coin, startTimeMs);

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

  if (btcCandles && (btcCorrMin != null || btcCorrMax != null)) {
    console.log(
      `Applying BTC correlation filter: min=${
        btcCorrMin != null ? btcCorrMin.toFixed(2) : '-∞'
      }, max=${btcCorrMax != null ? btcCorrMax.toFixed(2) : '+∞'}`
    );
  }

  const filteredResults = results.filter((r) => {
    if (btcCorrMin == null && btcCorrMax == null) return true;
    if (!Number.isFinite(r.btcCorr)) return false;
    if (btcCorrMin != null && r.btcCorr < btcCorrMin) return false;
    if (btcCorrMax != null && r.btcCorr > btcCorrMax) return false;
    return true;
  });

  filteredResults.sort((a, b) => b.rvol - a.rvol);

  return filteredResults;
}

function printResultsTable(results, tradingDate) {
  if (!results || results.length === 0) {
    console.log('No RVOL results to display.');
    return;
  }

  const table = results.map((r) => ({
    Asset: r.asset,
    RVOL: r.rvol.toFixed(2),
    '12h Volume ($)': formatUsd(r.current12hVolumeUsd),
    Price: formatPrice(r.price),
    'BTC Corr': r.btcCorr != null && Number.isFinite(r.btcCorr) ? r.btcCorr.toFixed(2) : 'n/a',
  }));

  console.log(`\n=== RVOL Results for ${tradingDate} ===`);
  console.table(table);

  const top = results[0];
  console.log(
    `\nTop Asset in Play: ${top.asset} | RVOL: ${top.rvol.toFixed(
      2
    )} | 12h Vol: $${formatUsd(top.current12hVolumeUsd)} | Price: $${formatPrice(
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
  if (options.btcCorrMin != null || options.btcCorrMax != null) {
    console.log(
      `CLI BTC correlation filter requested: min=${
        options.btcCorrMin != null ? options.btcCorrMin : '-∞'
      }, max=${options.btcCorrMax != null ? options.btcCorrMax : '+∞'}`
    );
  }
  if (options.forceRefresh) {
    console.log('Force refresh enabled: ignoring any cached runs for today.');
  }

  ensureDataDir();
  const db = openDatabase();

  try {
    let results;

    const cached = options.forceRefresh ? null : getCachedRun(db, tradingDate);

    if (cached) {
      console.log(
        `Using cached results for trading date ${tradingDate} (created at ${new Date(
          cached.createdAt
        ).toISOString()})`
      );
      results = cached.results;
    } else {
      results = await performFreshScan(
        tradingDate,
        options.btcCorrMin,
        options.btcCorrMax
      );
      saveRun(db, tradingDate, results);
      writeResultsFile(tradingDate, results);
    }

    // Apply BTC correlation filter on cached or freshly computed results
    let finalResults = results;
    if (options.btcCorrMin != null || options.btcCorrMax != null) {
      console.log(
        `Applying BTC correlation filter to loaded results: min=${
          options.btcCorrMin != null ? options.btcCorrMin : '-∞'
        }, max=${options.btcCorrMax != null ? options.btcCorrMax : '+∞'}`
      );
      finalResults = results.filter((r) => {
        if (!Number.isFinite(r.btcCorr)) return false;
        if (options.btcCorrMin != null && r.btcCorr < options.btcCorrMin) return false;
        if (options.btcCorrMax != null && r.btcCorr > options.btcCorrMax) return false;
        return true;
      });
    }

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
  fetchMeta,
  extractPerpAssets,
  fetchCandles,
  sleep,
  computeCurrentAndBaselineVolumes,
  computeAssetStats,
};


