## RVOL Frontend Integration Contract

This document describes how a React frontend can consume:

- **Live monitor snapshots** over WebSocket.
- The **latest RVOL report** as JSON.

All examples assume local development on the same machine as this project.

---

### 1. Live monitor WebSocket

- **URL (dev)**: `ws://localhost:4000/ws/live-monitor`
- **Server entrypoint**: run from this repo root:

```bash
PORT=4000 SNAPSHOT_MODE=preopen node live_server.js
```

#### 1.1 Message types

All messages are JSON objects with a `type` field and a `version` field.

- **Hello message** (sent once on connect):

```json
{
  "type": "hello",
  "version": 1,
  "snapshotMode": "preopen",
  "message": "Connected to RVOL live monitor server"
}
```

- **Live monitor update** (sent periodically, default every 5s):

```json
{
  "type": "live-monitor.update",
  "version": 1,
  "snapshotMode": "preopen",
  "asOf": "2026-03-17T14:32:05.123Z",
  "rows": [
    {
      "coin": "BTC",
      "spreadPct": 0.03,
      "bidDepth": 123456.78,
      "askDepth": 98765.43,
      "totalDepth": 222222.21,
      "delta": 15000.0,
      "imbalancePct": 25.3,
      "isSpreadOk": true,
      "isDirectionStrong": true,
      "score": 5.42
    }
  ]
}
```

#### 1.2 TypeScript types (frontend)

```ts
export interface LiveMonitorRow {
  coin: string;
  spreadPct: number;
  bidDepth: number;
  askDepth: number;
  totalDepth: number;
  delta: number;
  imbalancePct: number;
  isSpreadOk: boolean;
  isDirectionStrong: boolean;
  score: number;
}

export interface LiveMonitorUpdateMessage {
  type: 'live-monitor.update';
  version: 1;
  snapshotMode: 'preopen' | 'live';
  asOf: string; // ISO8601
  rows: LiveMonitorRow[];
}

export interface HelloMessage {
  type: 'hello';
  version: 1;
  snapshotMode: 'preopen' | 'live';
  message: string;
}

export type LiveMonitorMessage = LiveMonitorUpdateMessage | HelloMessage;
```

#### 1.3 React hook example

```ts
import { useEffect, useState } from 'react';

export function useLiveMonitor(url: string) {
  const [rows, setRows] = useState<LiveMonitorRow[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = new WebSocket(url);
    let closedByUser = false;

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => {
        setConnected(true);
      };

      ws.onclose = () => {
        setConnected(false);
        if (!closedByUser) {
          setTimeout(connect, 2000); // simple reconnect
        }
      };

      ws.onerror = () => {
        ws?.close();
      };

      ws.onmessage = (event) => {
        try {
          const msg: LiveMonitorMessage = JSON.parse(event.data);
          if (msg.type === 'live-monitor.update') {
            const sorted = [...msg.rows].sort((a, b) => b.score - a.score);
            setRows(sorted);
            setAsOf(msg.asOf);
          }
        } catch (e) {
          console.error('Failed to parse live-monitor message', e);
        }
      };
    }

    connect();

    return () => {
      closedByUser = true;
      ws?.close();
    };
  }, [url]);

  return { rows, asOf, connected };
}
```

Usage:

```tsx
const { rows, asOf, connected } = useLiveMonitor('ws://localhost:4000/ws/live-monitor');
```

---

### 2. Latest RVOL report JSON

The backend helper `latest_report.js` exposes:

- `loadLatestReportFromDatabase(snapshotMode?)`

It returns the following normalized shape:

```ts
export interface RvolResultRow {
  asset: string;
  rvol: number;
  current12hVolumeUsd: number;
  dayNtlVlm: number | null;
  openInterest: number | null;
  funding: number | null;
  price: number | null;
  btcCorr: number | null;
  runTimestamp: number;
}

export interface LatestRvolReport {
  tradingDate: string; // YYYY-MM-DD (ET trading date)
  snapshotMode: 'preopen' | 'live';
  generatedAt: number; // ms since epoch
  results: RvolResultRow[];
}
```

#### 2.1 HTTP endpoint

The live server already exposes this data over HTTP:

- **Method**: `GET`
- **URL (dev)**: `http://localhost:4000/api/latest-report`
- **Query (optional)**: `?snapshotMode=preopen` or `?snapshotMode=live`
- **Response**: `LatestRvolReport` JSON.

Example response:

```json
{
  "tradingDate": "2026-03-12",
  "snapshotMode": "preopen",
  "generatedAt": 1773325113867,
  "results": [
    {
      "asset": "ZEREBRO",
      "rvol": 6.95,
      "current12hVolumeUsd": 530183.904148,
      "dayNtlVlm": 12345678.9,
      "openInterest": 2345678.9,
      "funding": 0.000013,
      "price": 0.008312,
      "btcCorr": 0.23,
      "runTimestamp": 1773325092895
    }
  ]
}
```

#### 2.2 React fetch example

```ts
import { useEffect, useState } from 'react';

export function useLatestRvolReport(url: string) {
  const [report, setReport] = useState<LatestRvolReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = (await res.json()) as LatestRvolReport;
        if (!cancelled) {
          setReport(json);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? 'Unknown error');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    load();
    const id = setInterval(load, 60_000); // refresh every minute

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [url]);

  return { report, loading, error };
}
```

Usage:

```tsx
const { report, loading, error } = useLatestRvolReport('http://localhost:4000/api/latest-report');
```

---

### 3. Versioning and compatibility

- Every WebSocket message includes:
  - `type`: discriminator, e.g. `"hello"` or `"live-monitor.update"`.
  - `version`: currently `1`. Future changes can bump this.
- The frontend should:
  - Switch on `type`.
  - Ignore unknown fields.
  - Optionally warn if `version !== 1`.

This allows the backend to evolve fields without breaking existing frontend consumers.

