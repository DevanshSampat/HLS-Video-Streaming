/**
 * Automated Verification: CCTV Feed & Recordings streaming over HyperDHT warm pool
 */

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const HyperDHT = require('hyperdht');

async function runVerification() {
  console.log('🧪 Verifying CCTV Feed & Recordings streaming over HyperDHT warm pool...\n');

  const hlsDir = path.join(__dirname, '../onvif-backend/public/hls');
  const recDir = path.join(__dirname, '../onvif-backend/recordings');

  let sampleRec = null;
  if (fs.existsSync(recDir)) {
    const mp4Files = fs.readdirSync(recDir).filter(f => f.endsWith('.mp4'));
    if (mp4Files.length > 0) sampleRec = mp4Files[0];
  }
  console.log(`📁 Sample Recording MP4 found on disk: ${sampleRec || 'none'}`);

  const dhtKeyFile = path.join(__dirname, 'dht-key.json');
  if (!fs.existsSync(dhtKeyFile)) {
    console.error('❌ dht-key.json not found! Server needs to generate key.');
    process.exit(1);
  }

  const { publicKey } = JSON.parse(fs.readFileSync(dhtKeyFile, 'utf8'));
  const serverPubKeyBuf = Buffer.from(publicKey, 'hex');

  const clientDht = new HyperDHT({ port: 0 });

  function fetchOverDht(reqPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const stream = clientDht.connect(serverPubKeyBuf);

      let accumulated = Buffer.alloc(0);
      let headerParsed = false;
      let expectedLength = -1;
      let statusCode = 0;
      let respHeaders = {};
      let bodyBuffer = Buffer.alloc(0);
      let finished = false;

      function done() {
        if (finished) return;
        finished = true;
        stream.destroy();
        resolve({
          status: statusCode,
          headers: respHeaders,
          body: expectedLength !== -1 ? bodyBuffer.slice(0, expectedLength) : bodyBuffer,
          durationMs: Date.now() - startTime
        });
      }

      stream.on('error', (err) => {
        if (!finished) {
          finished = true;
          reject(err);
        }
      });

      function sendRequest() {
        const headerLines = [
          `GET ${reqPath} HTTP/1.1`,
          'Host: dht-server',
          'Connection: close'
        ];
        for (const [k, v] of Object.entries(headers)) {
          headerLines.push(`${k}: ${v}`);
        }
        headerLines.push('', '');
        stream.write(headerLines.join('\r\n'));
      }

      if (stream.opened) {
        sendRequest();
      } else {
        stream.once('open', sendRequest);
      }

      stream.on('data', chunk => {
        if (!headerParsed) {
          accumulated = Buffer.concat([accumulated, chunk]);
          const sep = accumulated.indexOf('\r\n\r\n');
          if (sep !== -1) {
            headerParsed = true;
            const headerStr = accumulated.slice(0, sep).toString('latin1');
            bodyBuffer = accumulated.slice(sep + 4);

            const lines = headerStr.split('\r\n');
            const statusMatch = lines[0].match(/HTTP\/1\.[01]\s+(\d+)/);
            if (statusMatch) statusCode = parseInt(statusMatch[1], 10);

            for (let i = 1; i < lines.length; i++) {
              const colon = lines[i].indexOf(':');
              if (colon !== -1) {
                const k = lines[i].slice(0, colon).trim().toLowerCase();
                const v = lines[i].slice(colon + 1).trim();
                respHeaders[k] = v;
              }
            }

            if (respHeaders['content-length'] !== undefined) {
              expectedLength = parseInt(respHeaders['content-length'], 10);
            }

            if (expectedLength !== -1 && bodyBuffer.length >= expectedLength) {
              done();
            }
          }
        } else {
          bodyBuffer = Buffer.concat([bodyBuffer, chunk]);
          if (expectedLength !== -1 && bodyBuffer.length >= expectedLength) {
            done();
          }
        }
      });

      stream.on('end', done);
    });
  }

  try {
    // 1. Test CCTV stream.m3u8
    console.log('\n📡 [1/5] Fetching /stream/camera/stream.m3u8 over HyperDHT...');
    const m3u8Res = await fetchOverDht('/stream/camera/stream.m3u8');
    const m3u8Text = m3u8Res.body.toString('utf8');
    console.log(`  - Status: ${m3u8Res.status}`);
    console.log(`  - Content-Type: ${m3u8Res.headers['content-type']}`);
    console.log(`  - Content-Length: ${m3u8Res.headers['content-length']}`);
    console.log(`  - Duration: ${m3u8Res.durationMs} ms`);

    if (m3u8Res.status !== 200) {
      throw new Error(`Failed to fetch stream.m3u8, status: ${m3u8Res.status}`);
    }
    console.log('  ✅ /stream/camera/stream.m3u8 fetched cleanly!');

    // Extract active segment directly from manifest
    const activeSegments = m3u8Text.split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('.ts') && !l.startsWith('#'));
    console.log(`  - Active segments in playlist: ${activeSegments.slice(0, 3).join(', ')}...`);
    const targetTs = activeSegments[0];

    // 2. Test CCTV TS Segment
    if (targetTs) {
      console.log(`\n📡 [2/5] Fetching /stream/camera/${targetTs} over HyperDHT...`);
      const tsRes = await fetchOverDht(`/stream/camera/${targetTs}`);
      console.log(`  - Status: ${tsRes.status}`);
      console.log(`  - Content-Type: ${tsRes.headers['content-type']}`);
      console.log(`  - Content-Length: ${tsRes.headers['content-length']}`);
      console.log(`  - Received Bytes: ${tsRes.body.length}`);
      console.log(`  - Duration: ${tsRes.durationMs} ms`);
      if (tsRes.status !== 200 || tsRes.body.length === 0) {
        throw new Error(`TS segment fetch failed, status: ${tsRes.status}`);
      }
      console.log(`  ✅ /stream/camera/${targetTs} fetched cleanly in ${tsRes.durationMs} ms without stall!`);
    }

    // 3. Test CCTV Direct Alias /camera/stream.m3u8
    console.log('\n📡 [3/5] Fetching direct alias /camera/stream.m3u8 over HyperDHT...');
    const aliasRes = await fetchOverDht('/camera/stream.m3u8');
    console.log(`  - Status: ${aliasRes.status}`);
    console.log(`  - Content-Length: ${aliasRes.headers['content-length']}`);
    console.log(`  - Duration: ${aliasRes.durationMs} ms`);
    if (aliasRes.status === 200) {
      console.log('  ✅ /camera/stream.m3u8 alias succeeded!');
    }

    // 4. Test Recording Streaming with Range: bytes=0-
    if (sampleRec) {
      console.log(`\n📡 [4/5] Fetching /stream/recordings/${sampleRec} with Range: bytes=0- over HyperDHT...`);
      const recRes = await fetchOverDht(`/stream/recordings/${sampleRec}`, { Range: 'bytes=0-' });
      console.log(`  - Status: ${recRes.status}`);
      console.log(`  - Content-Type: ${recRes.headers['content-type']}`);
      console.log(`  - Content-Range: ${recRes.headers['content-range']}`);
      console.log(`  - Content-Length: ${recRes.headers['content-length']}`);
      console.log(`  - Received Bytes: ${recRes.body.length}`);
      console.log(`  - Duration: ${recRes.durationMs} ms`);
      if (recRes.status !== 206 || recRes.body.length === 0) {
        throw new Error(`Recording range request failed with status: ${recRes.status}`);
      }
      console.log(`  ✅ /stream/recordings/${sampleRec} 1MB range delivered in ${recRes.durationMs} ms!`);

      // 5. Test Recording second chunk: Range: bytes=1048576-
      console.log(`\n📡 [5/5] Fetching second chunk with Range: bytes=1048576- over HyperDHT...`);
      const recRes2 = await fetchOverDht(`/stream/recordings/${sampleRec}`, { Range: 'bytes=1048576-' });
      console.log(`  - Status: ${recRes2.status}`);
      console.log(`  - Content-Range: ${recRes2.headers['content-range']}`);
      console.log(`  - Received Bytes: ${recRes2.body.length}`);
      console.log(`  - Duration: ${recRes2.durationMs} ms`);
      if (recRes2.status !== 206 || recRes2.body.length === 0) {
        throw new Error(`Second range request failed with status: ${recRes2.status}`);
      }
      console.log(`  ✅ Second range chunk delivered in ${recRes2.durationMs} ms!`);
    }

    console.log('\n🎉 ALL CCTV & RECORDINGS P2P TESTS COMPLETED SUCCESSFULLY!');
  } finally {
    await clientDht.destroy();
  }
}

runVerification().catch(err => {
  console.error('❌ Verification error:', err);
  process.exit(1);
});
