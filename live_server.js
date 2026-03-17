// live_server.js
// WebSocket server that exposes live RVOL monitor snapshots for frontend consumers.

const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const {
  getLatestReportAssets,
  createEmptyState,
  handleChannelMessage,
  buildLiveRows,
} = require('./live_monitor');
const { loadLatestReportFromDatabase } = require('./latest_report');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'hyperliquid_rvol.db');
const WS_URL = 'wss://api.hyperliquid.xyz/ws';

const SNAPSHOT_MODE = process.env.SNAPSHOT_MODE || 'preopen';
const PORT = Number(process.env.PORT) || 4000;
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 5000;

function openDatabase() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

function getCoinsToMonitor() {
  const db = openDatabase();
  try {
    return getLatestReportAssets(db);
  } finally {
    db.close();
  }
}

function createHyperliquidConnection(coins, state) {
  if (!coins || coins.length === 0) {
    console.log('No coins to monitor. Live WS server will not start Hyperliquid connection.');
    return null;
  }

  console.log('Live WS server subscribing to coins:', coins.join(', '));

  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('Live WS server connected to Hyperliquid backend.');

    for (const coin of coins) {
      const subBook = {
        method: 'subscribe',
        subscription: {
          type: 'l2Book',
          coin,
        },
      };
      ws.send(JSON.stringify(subBook));

      const subTrades = {
        method: 'subscribe',
        subscription: {
          type: 'trades',
          coin,
        },
      };
      ws.send(JSON.stringify(subTrades));
    }
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleChannelMessage(state, msg);
    } catch (e) {
      console.error('Live WS server failed to parse Hyperliquid message:', e.message || e);
    }
  });

  ws.on('error', (err) => {
    console.error('Live WS server Hyperliquid error:', err.message || err);
  });

  ws.on('close', (code, reason) => {
    console.log('Live WS server Hyperliquid connection closed:', code, reason?.toString());
  });

  return ws;
}

function startLiveMonitorServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url && req.url.startsWith('/api/latest-report')) {
      try {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const snapshotModeParam = url.searchParams.get('snapshotMode');
        const snapshotMode = snapshotModeParam === '' ? null : snapshotModeParam;

        const report = loadLatestReportFromDatabase(snapshotMode || null);
        if (!report) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'No report data available' }));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify(report));
        return;
      } catch (e) {
        console.error('Error handling /api/latest-report:', e.message || e);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
        return;
      }
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not found');
  });
  const wss = new WebSocket.Server({ server, path: '/ws/live-monitor' });

  const state = createEmptyState();
  const coins = getCoinsToMonitor();
  const hyperliquidWs = createHyperliquidConnection(coins, state);

  wss.on('connection', (socket) => {
    console.log('Frontend client connected to live monitor WebSocket.');

    socket.send(
      JSON.stringify({
        type: 'hello',
        version: 1,
        snapshotMode: SNAPSHOT_MODE,
        message: 'Connected to RVOL live monitor server',
      })
    );

    socket.on('close', () => {
      console.log('Frontend client disconnected from live monitor WebSocket.');
    });
  });

  setInterval(() => {
    const rows = buildLiveRows(state);

    const payload = {
      type: 'live-monitor.update',
      version: 1,
      snapshotMode: SNAPSHOT_MODE,
      asOf: new Date().toISOString(),
      rows,
    };

    const data = JSON.stringify(payload);

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }, MONITOR_INTERVAL_MS);

  server.listen(PORT, () => {
    console.log(
      `RVOL live monitor WebSocket server listening on port ${PORT} at /ws/live-monitor (snapshot mode: ${SNAPSHOT_MODE})`
    );
  });

  function shutdown() {
    console.log('Shutting down live monitor server...');
    server.close();
    if (hyperliquidWs && hyperliquidWs.readyState === WebSocket.OPEN) {
      hyperliquidWs.close();
    }
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  startLiveMonitorServer();
}

module.exports = {
  startLiveMonitorServer,
};

