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
  const proxyServer = net.createServer((clientSocket) => {
    // When a browser or player connects, open a hole-punched DHT stream
    const dhtStream = dht.connect(serverPublicKey);

    // Proactively clean up stream pairs on close without triggering premature close errors
    clientSocket.on('close', () => {
      if (!dhtStream.destroyed) dhtStream.destroy();
    });

    dhtStream.on('close', () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });

    dhtStream.on('error', (err) => {
      // Suppress normal peer/player disconnect errors and stream aborts
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

    // Bidirectional piping between local TCP player and remote hole-punched DHT stream
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

  process.on('SIGINT', async () => {
    console.log('\nClosing proxy...');
    proxyServer.close();
    await dht.destroy();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    proxyServer.close();
    await dht.destroy();
    process.exit(0);
  });
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
