// latest_report.js
// Helper utility to load the latest RVOL report snapshot from SQLite for frontend consumption.

const Database = require('better-sqlite3');

const DB_PATH = require('path').join(__dirname, 'data', 'hyperliquid_rvol.db');

function openDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function loadLatestReportFromDatabase(snapshotMode = null) {
  const db = openDatabase();
  try {
    let row;
    if (snapshotMode) {
      row = db
        .prepare(
          `
          SELECT trading_date
          FROM report
          WHERE snapshot_mode = ?
          ORDER BY trading_date DESC
          LIMIT 1
        `
        )
        .get(snapshotMode);
    } else {
      row = db
        .prepare(
          `
          SELECT trading_date, snapshot_mode
          FROM report
          ORDER BY trading_date DESC
          LIMIT 1
        `
        )
        .get();
    }

    if (!row) {
      return null;
    }

    const tradingDate = row.trading_date;
    const resolvedSnapshotMode = snapshotMode || row.snapshot_mode;

    const results = db
      .prepare(
        `
        SELECT
          asset,
          rvol,
          current_12h_volume_usd AS current12hVolumeUsd,
          day_ntl_vlm AS dayNtlVlm,
          open_interest AS openInterest,
          oi_24h_vol_ratio AS oi24hVolRatio,
          funding,
          price,
          btc_corr AS btcCorr,
          run_timestamp AS runTimestamp
        FROM report
        WHERE trading_date = ?
          AND snapshot_mode = ?
        ORDER BY rvol DESC
      `
      )
      .all(tradingDate, resolvedSnapshotMode);

    let generatedAt = null;
    for (const r of results) {
      if (Number.isFinite(r.runTimestamp)) {
        if (generatedAt == null || r.runTimestamp > generatedAt) {
          generatedAt = r.runTimestamp;
        }
      }
    }
    if (generatedAt == null) {
      generatedAt = Date.now();
    }

    return {
      tradingDate,
      snapshotMode: resolvedSnapshotMode,
      generatedAt,
      results,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  loadLatestReportFromDatabase,
};

