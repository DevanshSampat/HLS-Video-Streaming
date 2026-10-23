/**
 * End-to-End WebRTC Browser Hole-Punching & Streaming Verification Test
 * Tests WebRTC DataChannel connectivity, MQTT signaling, and HTTP-over-DataChannel streaming.
 */

const http = require('http');
const express = require('express');
const mqtt = require('mqtt');
const nodeDataChannel = require('node-datachannel');
const webrtcServer = require('./webrtcServer');

async function runTests() {
  console.log('🧪 Starting StreamVilla WebRTC Browser Verification Tests...\n');

  // 1. Setup Express App
  const app = express();
  app.use(express.json());
  app.get('/api/ping', (req, res) => res.json({ pong: true, time: Date.now() }));
  app.get('/device-name', (req, res) => res.json({
    name: 'Test-PC',
    p2p: true,
    webrtc: true,
    battery: 100,
    charging: true
  }));
  app.get('/videos', (req, res) => res.json([
    { name: 'test-video.mp4', path: 'streams/test-video/master.m3u8', subtitle: true }
  ]));
  app.get('/sample-chunk.ts', (req, res) => {
    res.setHeader('Content-Type', 'video/mp2t');
    // Send 128KB dummy binary video chunk
    const chunk = Buffer.alloc(128 * 1024, 0x47); // 0x47 is TS sync byte
    res.end(chunk);
  });

  const httpServer = http.createServer(app);
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const localPort = httpServer.address().port;
  console.log(`✅ [1/5] Local test HTTP server running on port ${localPort}`);

  // 2. Setup WebRTC Server with a unique test DHT key
  const testDhtKey = 'test' + Date.now().toString(16) + '0'.repeat(48);
  webrtcServer.start(localPort, testDhtKey);
  console.log(`✅ [2/5] WebRTC Server listening for browser connections for key: ${testDhtKey.slice(0, 16)}...`);

  // Wait 1.5s for MQTT signaling connection
  await new Promise(r => setTimeout(r, 1500));

  // 3. Simulate Browser WebRTC Client
  console.log('📡 [3/5] Simulating Browser WebRTC client connecting via MQTT signaling...');
  const sessionId = `browser_${Date.now()}`;
  const browserMqtt = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
    clientId: `sim_${sessionId}`,
    clean: true
  });

  const browserPc = new nodeDataChannel.PeerConnection('SimulatedBrowser', {
    iceServers: ['stun:stun.l.google.com:19302']
  });

  let browserDc = null;

  const answerTopic = `streamvilla/${testDhtKey}/answer/${sessionId}`;
  const candidateTopic = `streamvilla/${testDhtKey}/candidate/${sessionId}`;
  const offerTopic = `streamvilla/${testDhtKey}/offer`;
  const browserCandidateTopic = `streamvilla/${testDhtKey}/candidate`;

  const pendingCandidates = [];
  let hasRemoteDesc = false;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Signaling handshake timed out')), 10000);

    browserPc.onLocalDescription((sdp, type) => {
      browserMqtt.publish(offerTopic, JSON.stringify({
        sessionId,
        type,
        sdp
      }));
    });

    browserPc.onLocalCandidate((candidate, mid) => {
      browserMqtt.publish(browserCandidateTopic, JSON.stringify({
        sessionId,
        type: 'candidate',
        candidate,
        mid
      }));
    });

    browserMqtt.on('connect', () => {
      browserMqtt.subscribe([answerTopic, candidateTopic], (err) => {
        if (err) return reject(err);

        // Now create DataChannel to trigger offer generation
        browserDc = browserPc.createDataChannel('streamvilla-data');
        browserDc.onOpen(() => {
          clearTimeout(timeout);
          console.log('✅ [3/5] Direct WebRTC DataChannel established between Browser and PC!');
          resolve();
        });
      });
    });

    browserMqtt.on('message', (topic, payload) => {
      const msg = JSON.parse(payload.toString('utf8'));
      if (msg.sessionId !== sessionId) return;

      if (topic === answerTopic && msg.type === 'answer') {
        browserPc.setRemoteDescription(msg.sdp, msg.type);
        hasRemoteDesc = true;
        for (const c of pendingCandidates) {
          try { browserPc.addRemoteCandidate(c.candidate, c.mid); } catch (e) {}
        }
      } else if (topic === candidateTopic && msg.type === 'candidate') {
        if (!hasRemoteDesc) {
          pendingCandidates.push(msg);
        } else {
          try { browserPc.addRemoteCandidate(msg.candidate, msg.mid); } catch (e) {}
        }
      }
    });
  });

  // 4. Test API request: GET /device-name over WebRTC DataChannel
  console.log('📡 [4/5] Testing GET /device-name over direct WebRTC DataChannel...');
  
  function browserFetch(url) {
    return new Promise((resolve, reject) => {
      const reqId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const chunks = [];
      let respInfo = null;

      const onMsg = (msg) => {
        if (typeof msg === 'string') {
          const data = JSON.parse(msg);
          if (data.id === reqId) {
            if (data.type === 'start') {
              respInfo = data;
            } else if (data.type === 'end') {
              cleanup();
              const merged = Buffer.concat(chunks);
              resolve({
                statusCode: respInfo ? respInfo.statusCode : 200,
                headers: respInfo ? respInfo.headers : {},
                body: merged
              });
            } else if (data.type === 'error') {
              cleanup();
              reject(new Error(data.error));
            }
          }
        } else {
          // Binary message: [1 byte: len][id string][chunk]
          const idLen = msg[0];
          const id = msg.slice(1, 1 + idLen).toString('utf8');
          if (id === reqId) {
            chunks.push(msg.slice(1 + idLen));
          }
        }
      };

      const cleanup = () => {
        // remove listener
      };

      browserDc.onMessage(onMsg);
      browserDc.sendMessage(JSON.stringify({ id: reqId, url, method: 'GET' }));
    });
  }

  const devRes = await browserFetch('/device-name');
  const devData = JSON.parse(devRes.body.toString('utf8'));
  if (!devData.webrtc || devData.name !== 'Test-PC') {
    throw new Error('Device name response invalid');
  }
  console.log('✅ [4/5] Direct WebRTC GET /device-name succeeded:', devData);

  // 5. Test 128KB Video Chunk streaming over WebRTC DataChannel
  console.log('📡 [5/5] Testing 128KB binary video chunk streaming over WebRTC DataChannel...');
  const chunkRes = await browserFetch('/sample-chunk.ts');
  if (chunkRes.body.length !== 128 * 1024) {
    throw new Error(`Expected 131072 bytes, got ${chunkRes.body.length}`);
  }
  if (chunkRes.body[0] !== 0x47) {
    throw new Error('Invalid TS sync byte');
  }
  console.log(`✅ [5/5] Streamed ${chunkRes.body.length} bytes of video segment over WebRTC DataChannel successfully!`);

  // Cleanup
  browserMqtt.end();
  browserPc.close();
  webrtcServer.stop();
  httpServer.close();

  console.log('\n🎉 ALL WEBRTC BROWSER TESTS PASSED SUCCESSFULLY!\n');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
