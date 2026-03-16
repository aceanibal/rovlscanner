## Hyperliquid RVOL Scanner

This project provides a Node.js script, `rvol_scanner.js`, that scans all Hyperliquid perpetual markets, computes 12‑hour Relative Volume (RVOL) against a 5‑day baseline, and identifies the **top asset in play** for intraday trading.

The script is designed to be run once each trading day (for example, between 9:00–9:30am US Eastern), then reused throughout the day without re-fetching data, thanks to a simple SQLite cache and per‑day JSON snapshots.

---

### Core Workflow

- **1. Discover asset universe + market context**
  - Calls Hyperliquid `metaAndAssetCtxs` via `POST https://api.hyperliquid.xyz/info` with `{ type: "metaAndAssetCtxs" }`.
  - Normalizes the response and:
    - Extracts all perpetual asset symbols from the `universe` array, skipping delisted markets.
    - Captures **market context per asset** (`dayNtlVlm`, `openInterest`, `funding`, `markPx`, etc.).
  - Persists a **per-asset snapshot** of this context into SQLite (`asset_ctx_snapshots`), keyed by **trading date + snapshot mode**.

- **2. Fetch 5 days of 1h candles per asset (anchored by snapshot mode)**
  - For each asset, calls `candleSnapshot` via the same `/info` endpoint:
    - `{ type: "candleSnapshot", req: { coin, interval: "1h", startTime, endTime } }`
  - `endTime` depends on the **snapshot mode**:
    - **preopen**: 9:00am US Eastern on the trading date.
    - **live**: current time (latest available 1h candle).
  - `startTime` is always **5 days before** `endTime`.
  - Applies a small delay (50ms) between requests to stay friendly to rate limits.
  - Parses each candle into numeric fields (open, high, low, close, volume).

- **3. Compute 12h RVOL**
  - Sorts candles ascending by time.
  - **Current 12h volume**:
    - Takes the **last 12 candles** (12 × 1h) and sums `volume * close` for dollar volume.
  - **Historical baseline**:
    - Uses all prior candles (excluding the last 12).
    - Splits into **non‑overlapping 12‑candle chunks**.
    - Computes dollar volume per chunk and averages them to get the 12h baseline.
  - **RVOL**:
    - `RVOL = current_12h_dollar_volume / baseline_12h_dollar_volume`.
    - Assets without enough data or a stable baseline are skipped.

- **4. Compute BTC correlation (optional)**
  - For BTC and each asset, builds **hourly log‑return** series from closes over the same 5‑day window.
  - Aligns timestamps and computes **Pearson correlation** of asset returns vs BTC returns.
  - The resulting `btcCorr` is stored alongside RVOL metrics and can be used to:
    - Focus on **high‑beta BTC followers**.
    - Or find **low‑correlation / independent** assets.

- **5. Cache and output**
  - Determines the **trading date** using US Eastern (`America/New_York`), e.g., `2026‑03‑12`.
  - Builds a **trading key**: `tradingDate:snapshotMode`, e.g. `2026‑03‑16:preopen` or `2026‑03‑16:live`.
  - Checks SQLite (`data/hyperliquid_rvol.db`, table `runs`) for an existing row with that key:
    - If present, loads cached results and **does not refetch** candles.
    - If absent, performs a fresh scan and then inserts a new row.
  - Writes a **JSON snapshot** per trading date and mode:
    - `data/rvol_results_YYYY-MM-DD_preopen.json` – 9:00am ET snapshot.
    - `data/rvol_results_YYYY-MM-DD_live.json` – live snapshot (up to run time).
    - Each file contains the full sorted result set:
      - `{ asset, rvol, current12hVolumeUsd, price, btcCorr, runDate, runTimestamp, dayNtlVlm, openInterest, funding }`.
  - Prints a **console table** with:
    - `Asset` – Hyperliquid perp symbol.
    - `RVOL` – 12h relative dollar volume vs 5‑day 12h baseline (current 12h / baseline 12h).
    - `12h Volume ($)` – dollar notional traded over the last 12 × 1h candles.
    - `24h Ntl Vol ($)` – 24h notional volume (`dayNtlVlm`) from Hyperliquid.
    - `OI ($)` – total open interest notional (`openInterest`) from Hyperliquid.
    - `OI/24h Vol` – ratio `OI / 24h Ntl Vol` (sanity check for crowded vs quiet markets).
    - `Funding` – current funding rate as a percentage (e.g. `0.0013%`).
    - `Price` – latest 1h close; uses more decimals for sub‑$1 assets so they don’t show as `0.00`.
    - `BTC Corr` – Pearson correlation of 1h log-returns vs BTC over the same 5‑day window (descriptive only, no longer used as a filter).
  - Finally logs the **Top Asset in Play** (highest RVOL) in a single summary line including RVOL, 12h volume, 24h volume, OI, funding, price, BTC correlation, and trading date.

---

### Installation

From the project root:

```bash
npm install
```

This installs the required dependencies:

- `axios` – HTTP client for the Hyperliquid `/info` endpoint.
- `better-sqlite3` – Embedded SQLite database for daily caching.
- `luxon` – Timezone‑aware datetime utilities (US Eastern trading date).

Node 18+ is recommended.

---

### Usage

Basic run (9:00am ET snapshot for today’s US Eastern trading date):

```bash
node rvol_scanner.js
```

- If **no cached preopen run** exists for today:
  - Fetches all data, computes 12h RVOL + BTC correlation using candles up to **9:00am ET**, writes JSON and SQLite under the `tradingDate:preopen` key.
- If a preopen run **already exists**:
  - Reuses cached results and simply prints the table and top asset as of 9:00am ET.

#### Snapshot modes: preopen vs live

You can choose between a fixed **9:00am ET snapshot** (`preopen`) and a **live snapshot** (`live`):

```bash
# 9:00am ET snapshot (default)
node rvol_scanner.js --snapshot-mode=preopen

# Live snapshot up to the latest available 1h candle
node rvol_scanner.js --snapshot-mode=live
```

- The script keys all cached runs and asset‑context snapshots by `tradingDate:snapshotMode`, so `preopen` and `live` results are stored separately and never overwrite each other.
- JSON snapshots are written to:
  - `data/rvol_results_YYYY-MM-DD_preopen.json`
  - `data/rvol_results_YYYY-MM-DD_live.json`

#### Force refresh (ignore cache)

If you change logic or want to recompute today’s snapshot from scratch:

```bash
# Recompute 9:00am snapshot
node rvol_scanner.js --snapshot-mode=preopen --force-refresh

# Recompute live snapshot
node rvol_scanner.js --snapshot-mode=live --force-refresh
```

This:
- Ignores any cached row for the selected `tradingDate:snapshotMode`.
- Re-fetches all candles, recomputes all metrics, overwrites SQLite and the corresponding JSON for that date+mode.

---

### Daily flow recommendation

Typical intraday usage pattern:

1. **Once per day during your main prep window (e.g., 9:00–9:30am ET)**:
   - Run a full **9:00am preopen refresh**:
   - `node rvol_scanner.js --snapshot-mode=preopen --force-refresh`
   - This gives you a stable list of assets **as they looked at 9:00am**, which you can use to judge how they performed from 9am–12pm and beyond.
2. **Later in the day**:
   - Re-run in `preopen` mode (no refetch, instant output) to revisit the 9:00am snapshot and measure how those assets behaved.
   - Optionally, run a separate **live snapshot** for current conditions:
   - `node rvol_scanner.js --snapshot-mode=live --force-refresh`
3. **Next day**:
   - The script automatically detects a new trading date and creates a new cached snapshot the first time you run it that day.

This keeps network usage low, makes repeated runs fast, and ensures the “Asset in Play” logic is consistent across all runs for a given trading session—while also giving you a clean **9:00am analytics anchor** for reviewing performance during the 9am–12pm window.

