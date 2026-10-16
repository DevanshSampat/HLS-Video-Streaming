#!/usr/bin/env node
/**
 * P2P Hole-Punching Client for HLS Video Streaming
 * Powered by HyperDHT (Holepunch)
 * 
 * Connects directly to any remote HLS Video Streaming server across the globe
 * through NATs, firewalls, and CGNAT without port forwarding.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const HyperDHT = require('hyperdht');

const args = process.argv.slice(2);

// Check if a 64-char hex key was provided or if we can auto-discover from local dht-key.json
let targetKey = args.find(a => /^[0-9a-fA-F]{64}$/.test(a));
const KEY_FILE = path.join(__dirname, 'dht-key.json');

if (!targetKey && fs.existsSync(KEY_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (data.publicKey) {
      targetKey = data.publicKey;
      console.log(`[Info] No key provided; auto-detected local server key: ${targetKey.slice(0, 16)}...`);
    }
  } catch (e) {}
}

if (!targetKey) {
  console.log(`
Usage:
  node client.js <SERVER_PUBLIC_KEY> [OPTIONS]

Options:
  --proxy [port]     Start a local HTTP proxy bridge (Default port: 8080)
                     Allows you to stream video in ANY browser or media player (Chrome/Safari/VLC)!
  --ping             Measure P2P round-trip hole-punching latency
  /path [METHOD]     Perform a direct CLI HTTP request (e.g. /videos or /api/status)

Examples:
  node client.js 9f8a...3b21 --proxy 8080
  node client.js 9f8a...3b21 /videos
  node client.js 9f8a...3b21 --ping
`);
  process.exit(1);
}

// Convert 64-character hex key into 32-byte Buffer
const serverPublicKey = Buffer.from(targetKey, 'hex');

// Create local DHT node (ephemeral UDP port to prevent conflicts)
const dht = new HyperDHT({ port: 0 });

const isPingMode = args.includes('--ping');
const proxyArgIndex = args.indexOf('--proxy');
const isProxyMode = proxyArgIndex !== -1 || (!isPingMode && !args.some(a => a.startsWith('/')));

// Determine proxy port
let proxyPort = 8080;
if (proxyArgIndex !== -1 && args[proxyArgIndex + 1] && !isNaN(args[proxyArgIndex + 1])) {
  proxyPort = parseInt(args[proxyArgIndex + 1], 10);
}

// -------------------------------------------------------------
// Mode 1: Local HTTP/TCP Proxy Bridge for Standard Web Browsers & Media Players
// -------------------------------------------------------------
// Helper to identify standard disconnects/aborts from browsers & players
function isNormalDisconnect(err) {
  if (!err) return true;
  const normalCodes = ['ECONNRESET', 'PREMATURE_CLOSE', 'ERR_STREAM_PREMATURE_CLOSE', 'ECANCELED', 'EPIPE', 'ETIMEDOUT'];
  if (normalCodes.includes(err.code)) return true;
  if (err.message && (
    err.message.includes('Writable stream closed') ||
    err.message.includes('Readable stream closed') ||
    err.message.includes('Premature close') ||
    err.message.includes('socket hang up')
  )) {
    return true;
  }
  return false;
}

if (isProxyMode) {
  // -------------------------------------------------------------
  // Warm Connection Pool for Instant Video Chunk Streaming
  // Pre-connects hole-punched DHT streams so the browser / media player
  // gets 0 ms connection delay on every playlist (.m3u8) & chunk (.ts)
  // -------------------------------------------------------------
  const WARM_POOL_SIZE = 4;
  const warmPool = [];

  function fillPool() {
    while (warmPool.length < WARM_POOL_SIZE) {
      const stream = dht.connect(serverPublicKey);
      if (!stream.setNoDelay) stream.setNoDelay = () => stream;
      if (!stream.setKeepAlive) stream.setKeepAlive = () => stream;

      const item = { stream, ready: false };

      stream.once('open', () => {
        item.ready = true;
      });
      stream.once('connect', () => {
        item.ready = true;
      });

      function onStreamDone() {
        const idx = warmPool.indexOf(item);
        if (idx !== -1) warmPool.splice(idx, 1);
        setTimeout(fillPool, 200);
      }

      stream.once('close', onStreamDone);
      stream.once('error', onStreamDone);

      warmPool.push(item);
    }
  }

  // Pre-fill warm pool immediately on launch
  fillPool();

  async function acquireWarmStream() {
    // 1. Try already-connected ready stream from the pool
    const readyIdx = warmPool.findIndex((i) => i.ready && !i.stream.destroyed);
    if (readyIdx !== -1) {
      const item = warmPool.splice(readyIdx, 1)[0];
      fillPool();
      return item.stream;
    }

    // 2. If streams are still handshaking, wait for the oldest to finish
    const pending = warmPool.find(i => !i.stream.destroyed);
    if (pending) {
      warmPool.splice(warmPool.indexOf(pending), 1);
      fillPool();
      if (!pending.ready) {
        await new Promise((resolve) => {
          pending.stream.once('open', resolve);
          pending.stream.once('error', resolve);
        });
      }
      if (!pending.stream.destroyed) return pending.stream;
    }

    // 3. Fallback: connect fresh and wait for open
    fillPool();
    const stream = dht.connect(serverPublicKey);
    if (!stream.setNoDelay) stream.setNoDelay = () => stream;
    if (!stream.setKeepAlive) stream.setKeepAlive = () => stream;
    await new Promise((resolve) => {
      stream.once('open', resolve);
      stream.once('error', resolve);
    });
    return stream;
  }

  const proxyServer = net.createServer(async (clientSocket) => {
    clientSocket.setNoDelay(true);
    clientSocket.setKeepAlive(true, 120000);

    const dhtStream = await acquireWarmStream();
    if (!dhtStream || dhtStream.destroyed) {
      clientSocket.destroy();
      return;
    }

    clientSocket.on('close', () => {
      if (!dhtStream.destroyed) dhtStream.destroy();
    });

    dhtStream.on('close', () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    dhtStream.on('error', (err) => {
      if (!isNormalDisconnect(err)) {
        console.warn('[Proxy Error] DHT stream error:', err.message);
      }
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    clientSocket.on('error', (err) => {
      if (!isNormalDisconnect(err)) {
        console.warn('[Proxy Error] Client socket error:', err.message);
      }
      if (!dhtStream.destroyed) dhtStream.destroy();
    });

    clientSocket.pipe(dhtStream).pipe(clientSocket);
  });

  function getLanIP() {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  proxyServer.listen(proxyPort, '0.0.0.0', () => {
    const lanIP = getLanIP();
    const line = '═'.repeat(74);
    console.log('\n' + line);
    console.log('  🎬 P2P HOLE-PUNCHING VIDEO STREAMING PROXY ACTIVE');
    console.log(line);
    console.log(`  🔑 Target DHT Server:  ${targetKey}`);
    console.log(`  💻 Local PC Browser:   http://localhost:${proxyPort}`);
    if (lanIP !== '127.0.0.1') {
      console.log(`  📱 Mobile Phone / TV:  http://${lanIP}:${proxyPort}`);
    }
    console.log(line);
    console.log(`  🍿 Open http://localhost:${proxyPort}/videos to list all available media`);
    console.log('     Every chunk and playlist is hole-punched & end-to-end encrypted!');
    console.log('     Press Ctrl+C to terminate the proxy.\n' + line + '\n');
  });

  const closeGracefully = async () => {
    console.log('\nClosing proxy...');
    proxyServer.close();
    for (const item of warmPool) {
      try {
        if (!item.stream.destroyed) item.stream.destroy();
      } catch (e) {}
    }
    await dht.destroy();
    process.exit(0);
  };

  process.on('SIGINT', closeGracefully);
  process.on('SIGTERM', closeGracefully);
}

// -------------------------------------------------------------
// Mode 2: P2P Latency Benchmark (--ping)
// -------------------------------------------------------------
else if (isPingMode) {
  console.log(`\nConnecting to hole-punched streaming server: ${targetKey.slice(0, 16)}...`);
  console.log('Punching NAT and establishing encrypted Noise stream...\n');

  async function pingOnce(seq) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const stream = dht.connect(serverPublicKey);
      let finished = false;

      function done() {
        if (finished) return;
        finished = true;
        const latency = Date.now() - startTime;
        console.log(`[Ping #${seq}] Round-trip latency: ${latency} ms (P2P Hole-Punched)`);
        stream.destroy();
        resolve(latency);
      }

      stream.on('error', (err) => {
        if (!finished) {
          finished = true;
          console.error(`[Ping #${seq}] Error:`, err.message);
          resolve(null);
        }
      });

      stream.write('GET /api/ping HTTP/1.1\r\nHost: dht-server\r\nConnection: close\r\n\r\n');

      let response = '';
      stream.on('data', chunk => {
        response += chunk.toString();
        if (response.includes('\r\n\r\n') && response.includes('"pong":true')) {
          done();
        }
      });

      stream.on('end', done);
    });
  }

  (async () => {
    for (let i = 1; i <= 4; i++) {
      await pingOnce(i);
      await new Promise(r => setTimeout(r, 400));
    }
    await dht.destroy();
    process.exit(0);
  })();
}

// -------------------------------------------------------------
// Mode 3: Direct CLI HTTP Request (/path)
// -------------------------------------------------------------
else {
  const reqPath = args.find(a => a.startsWith('/')) || '/api/status';
  const method = (args.find(a => ['GET', 'POST', 'PUT', 'DELETE'].includes(a.toUpperCase())) || 'GET').toUpperCase();

  console.log(`\n[P2P Hole-Punch] Sending ${method} ${reqPath} to ${targetKey.slice(0, 16)}...`);

  const stream = dht.connect(serverPublicKey);
  let rawData = '';
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;

    const separatorIndex = rawData.indexOf('\r\n\r\n');
    if (separatorIndex === -1) {
      console.log(rawData);
    } else {
      const headers = rawData.slice(0, separatorIndex);
      const body = rawData.slice(separatorIndex + 4);

      console.log('─── Response Headers ───');
      console.log(headers);
      console.log('\n─── Response Body ───');
      try {
        const parsed = JSON.parse(body);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(body);
      }
    }
    stream.destroy();
    dht.destroy().then(() => process.exit(0));
  }

  stream.on('error', (err) => {
    if (!finished) {
      console.error('[Connection Error]', err.message);
      dht.destroy().then(() => process.exit(1));
    }
  });

  const rawReq = `${method} ${reqPath} HTTP/1.1\r\nHost: dht-server\r\nUser-Agent: HolePunch-Client/1.0\r\nConnection: close\r\n\r\n`;
  stream.write(rawReq);

  stream.on('data', chunk => {
    rawData += chunk.toString();
    const sep = rawData.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headers = rawData.slice(0, sep);
      const match = headers.match(/content-length:\s*(\d+)/i);
      if (match) {
        const expectedLen = parseInt(match[1], 10);
        const bodyLen = Buffer.byteLength(rawData.slice(sep + 4));
        if (bodyLen >= expectedLen) {
          finish();
        }
      }
    }
  });

  stream.on('end', finish);
}
