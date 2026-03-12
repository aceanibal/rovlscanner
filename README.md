## Hyperliquid RVOL Scanner

This project provides a Node.js script, `rvol_scanner.js`, that scans all Hyperliquid perpetual markets, computes 12‑hour Relative Volume (RVOL) against a 5‑day baseline, and identifies the **top asset in play** for intraday trading.

The script is designed to be run once each trading day (for example, between 9:00–9:30am US Eastern), then reused throughout the day without re-fetching data, thanks to a simple SQLite cache and per‑day JSON snapshots.

---

### Core Workflow

- **1. Discover asset universe**
  - Calls Hyperliquid `meta` via `POST https://api.hyperliquid.xyz/info` with `{ type: "meta", dex: "" }`.
  - Extracts all perpetual asset symbols from the `universe` array, skipping delisted markets.

- **2. Fetch 5 days of 1h candles per asset**
  - For each asset, calls `candleSnapshot` via the same `/info` endpoint:
    - `{ type: "candleSnapshot", req: { coin, interval: "1h", startTime: fiveDaysAgoMs, endTime: null } }`.
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
  - Checks SQLite (`data/hyperliquid_rvol.db`, table `runs`) for an existing row for that date:
    - If present, loads cached results and **does not refetch** candles.
    - If absent, performs a fresh scan and then inserts a new row.
  - Writes a **JSON snapshot**:
    - `data/rvol_results_YYYY-MM-DD.json` containing the full sorted result set:
      - `{ asset, rvol, current12hVolumeUsd, price, btcCorr, runDate, runTimestamp }`.
  - Prints a **console table** with:
    - `Asset`, `RVOL`, `12h Volume ($)`, `Price`, `BTC Corr`.
  - Finally logs the **Top Asset in Play** (highest RVOL) in a single summary line.

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

Basic run (uses or creates cache for today’s US Eastern trading date):

```bash
node rvol_scanner.js
```

- If **no cached run** exists for today:
  - Fetches all data, computes RVOL + BTC correlation, writes JSON and SQLite.
- If a run **already exists**:
  - Reuses cached results and simply prints the table and top asset.

#### Force refresh (ignore cache)

If you change logic or want to recompute today’s snapshot from scratch:

```bash
node rvol_scanner.js --force-refresh
```

This:
- Ignores any cached row for today’s trading date.
- Re-fetches all candles, recomputes all metrics, overwrites SQLite and JSON for that date.

#### BTC correlation filters

You can optionally filter by BTC correlation:

```bash
# Only show assets with BTC correlation >= 0.5
node rvol_scanner.js --btc-corr-min=0.5

# Only show assets with BTC correlation <= 0.3
node rvol_scanner.js --btc-corr-max=0.3

# Only show assets with 0.2 <= corr <= 0.8
node rvol_scanner.js --btc-corr-min=0.2 --btc-corr-max=0.8
```

These filters work both on freshly computed runs and on cached days:
- On a **fresh run**, correlation is computed and filtered before persisting.
- On a **cached run**, the filter is applied to the loaded results in memory.

You can combine filters with `--force-refresh`, for example:

```bash
node rvol_scanner.js --force-refresh --btc-corr-min=0.5
```

---

### Daily flow recommendation

Typical intraday usage pattern:

1. **Once per day during your main prep window (e.g., 9:00–9:30am ET)**:
   - Run a full refresh:
   - `node rvol_scanner.js --force-refresh`
2. **Later in the day**:
   - Re-run with different BTC correlation filters (no refetch, instant output):
   - `node rvol_scanner.js --btc-corr-min=0.7`
   - `node rvol_scanner.js --btc-corr-max=0.2`
3. **Next day**:
   - The script automatically detects a new trading date and creates a new cached snapshot the first time you run it that day.

This keeps network usage low, makes repeated runs fast, and ensures the “Asset in Play” logic is consistent across all runs for a given trading session.

