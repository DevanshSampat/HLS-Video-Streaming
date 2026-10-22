/**
 * End-to-End P2P Hole Punching Test Suite for HLS Video Streaming
 * Tests hole-punched DHT connectivity, Express HTTP streaming, and Proxy Bridge.
 */

const http = require('http');
const net = require('net');
const HyperDHT = require('hyperdht');
const express = require('express');

async function runTests() {
  console.log('🧪 Starting HLS Video Streaming Hole-Punching Verification Tests...\n');

  // 1. Setup Express App
  const app = express();
  app.use(express.json());
  app.get('/api/ping', (req, res) => res.json({ pong: true, time: Date.now() }));
  app.get('/api/status', (req, res) => res.json({
    status: 'online',
    protocol: 'hyperdht/holepunch',
    service: 'streamvilla-hls-video-streaming'
  }));
  app.get('/videos', (req, res) => res.json([
    { name: 'test-video.mp4', path: 'streams/test-video/master.m3u8', subtitle: true }
  ]));
  app.get('/api/large-chunk.ts', (req, res) => {
    const size = 20 * 1024 * 1024; // 20 MB (exceeds 16MB atomic write limit)
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': size,
      'Connection': 'close'
    });
    res.end(Buffer.alloc(size));
  });

  const httpServer = http.createServer(app);

  // 2. Setup Server DHT
  const serverDht = new HyperDHT({ port: 0 });
  const serverKeyPair = HyperDHT.keyPair();

  const P2P_FRAME_SIZE = 2 * 1024 * 1024;
  const dhtServer = serverDht.createServer((socket) => {
    if (!socket.setNoDelay) socket.setNoDelay = () => socket;
    if (!socket.setKeepAlive) socket.setKeepAlive = () => socket;
    if (!socket.destroySoon) socket.destroySoon = () => socket.end();
    socket.remoteAddress = socket.remotePublicKey ? socket.remotePublicKey.toString('hex') : 'peer';
    socket.encrypted = true;
    socket.on('error', () => {});

    const origWrite = socket.write.bind(socket);
    socket.write = function (data, encoding, cb) {
      if (typeof encoding === 'function') {
        cb = encoding;
        encoding = null;
      }
      if (Buffer.isBuffer(data) && data.length > P2P_FRAME_SIZE) {
        let offset = 0;
        let ret = true;
        while (offset < data.length) {
          const nextOffset = Math.min(offset + P2P_FRAME_SIZE, data.length);
          ret = origWrite(data.subarray(offset, nextOffset));
          offset = nextOffset;
        }
        if (typeof cb === 'function') process.nextTick(cb);
        return ret;
      }
      const ret = origWrite(data);
      if (typeof cb === 'function') process.nextTick(cb);
      return ret;
    };

    socket.on('drain', () => {
      if (socket._httpMessage) {
        socket._httpMessage.emit('drain');
      }
    });

    httpServer.emit('connection', socket);
  });

  await dhtServer.listen(serverKeyPair);
  const serverKey = serverKeyPair.publicKey.toString('hex');
  console.log(`✅ [1/5] Server listening on HyperDHT: ${serverKey.slice(0, 16)}...`);

  // 3. Setup Client DHT Node
  const clientDht = new HyperDHT({ port: 0 });
  const connectOpts = { relayAddresses: dhtServer.relayAddresses };

  // Helper to request over DHT stream
  function requestDHT(method, path, bodyData = null) {
    return new Promise((resolve, reject) => {
      const stream = clientDht.connect(serverKeyPair.publicKey, connectOpts);
      let rawData = '';
      let done = false;

      function finish() {
        if (done) return;
        done = true;
        try {
          const sep = rawData.indexOf('\r\n\r\n');
          const body = sep !== -1 ? rawData.slice(sep + 4) : rawData;
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${rawData}`));
        } finally {
          stream.destroy();
        }
      }

      stream.on('error', (err) => {
        if (!done && err.code !== 'ECONNRESET') reject(err);
      });

      const bodyStr = bodyData ? JSON.stringify(bodyData) : '';
      const headers = [
        `${method} ${path} HTTP/1.1`,
        'Host: dht-server',
        'Connection: close'
      ];
      if (bodyStr) {
        headers.push('Content-Type: application/json');
        headers.push(`Content-Length: ${Buffer.byteLength(bodyStr)}`);
      }
      headers.push('', bodyStr);
      stream.write(headers.join('\r\n'));

      stream.on('data', chunk => {
        rawData += chunk.toString();
        const sep = rawData.indexOf('\r\n\r\n');
        if (sep !== -1) {
          const headerStr = rawData.slice(0, sep);
          const match = headerStr.match(/content-length:\s*(\d+)/i);
          if (match) {
            const len = parseInt(match[1], 10);
            if (Buffer.byteLength(rawData.slice(sep + 4)) >= len) {
              finish();
            }
          }
        }
      });

      stream.on('end', finish);
    });
  }

  // Test 1: Direct GET /api/ping over hole-punched stream
  console.log('📡 [2/5] Testing direct GET /api/ping over DHT stream...');
  const pingResponse = await requestDHT('GET', '/api/ping');
  if (!pingResponse.pong) throw new Error('Expected { pong: true }');
  console.log('✅ [2/5] Direct P2P GET /api/ping succeeded!');

  // Test 2: Direct GET /videos over DHT stream
  console.log('📡 [3/5] Testing direct GET /videos over DHT stream...');
  const videosResponse = await requestDHT('GET', '/videos');
  if (!Array.isArray(videosResponse) || videosResponse.length === 0) throw new Error('Videos response invalid');
  console.log('✅ [3/5] Direct P2P GET /videos succeeded! Found video entries.');

  // Test 3: Local TCP Proxy Bridge
  console.log('📡 [4/5] Testing local HTTP browser proxy bridge...');
  const proxy = net.createServer((tcpSocket) => {
    const dhtStream = clientDht.connect(serverKeyPair.publicKey, connectOpts);
    dhtStream.on('error', () => tcpSocket.destroy());
    tcpSocket.on('error', () => dhtStream.destroy());
    tcpSocket.pipe(dhtStream).pipe(tcpSocket);
  });

  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;

  const proxyRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/api/ping`, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });

  if (!proxyRes.pong) throw new Error('Proxy failed to relay response');
  console.log('✅ [4/5] Local TCP browser proxy bridge successfully relayed HTTP traffic!');

  // Test 4: Transfer large chunk (> 16MB) over P2P
  console.log('📡 [5/5] Testing 20MB 4K chunk streaming over P2P (exceeds 16MB atomic limit)...');
  const largeChunkBytes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${proxyPort}/api/large-chunk.ts`, (res) => {
      let bytes = 0;
      res.on('data', chunk => { bytes += chunk.length; });
      res.on('end', () => resolve(bytes));
    }).on('error', reject);
  });

  if (largeChunkBytes !== 20 * 1024 * 1024) {
    throw new Error(`Expected 20971520 bytes, but received ${largeChunkBytes} bytes`);
  }
  console.log(`✅ [5/5] Successfully streamed ${largeChunkBytes} bytes (20MB) over P2P!`);

  // Cleanup
  proxy.close();
  await dhtServer.close();
  await serverDht.destroy();
  await clientDht.destroy();

  console.log('\n🎉 ALL P2P HOLE-PUNCHING TESTS (INCLUDING 20MB 4K STREAMING) PASSED SUCCESSFULLY!\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
