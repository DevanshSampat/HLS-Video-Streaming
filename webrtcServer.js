/**
 * WebRTC Server for HLS Video Streaming
 * Powered by node-datachannel + MQTT WebSocket Signaling
 * 
 * Enables modern web browsers to directly connect to this PC via WebRTC
 * peer-to-peer (UDP hole-punched via STUN) without requiring any local proxy client.
 */

const http = require('http');
const mqtt = require('mqtt');
const nodeDataChannel = require('node-datachannel');

const STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302'
];

const SIGNALING_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

const MAX_CHUNK_SIZE = 64 * 1024; // 64KB SCTP packet size limit

class WebRtcServer {
  constructor() {
    this.localPort = 9000;
    this.serverPublicKey = null;
    this.mqttClient = null;
    this.activePeers = new Map(); // sessionId -> { pc, dc, pendingCandidates, createdAt }
    this.isRunning = false;
  }

  start(localPort, serverPublicKey) {
    this.localPort = localPort || 9000;
    this.serverPublicKey = serverPublicKey;
    this.isRunning = true;

    console.log(`[WebRTC P2P] Initializing WebRTC direct browser server for key: ${this.serverPublicKey.slice(0, 16)}...`);
    this.connectSignaling(0);
  }

  connectSignaling(brokerIndex) {
    if (!this.isRunning) return;

    const brokerUrl = SIGNALING_BROKERS[brokerIndex % SIGNALING_BROKERS.length];
    console.log(`[WebRTC Signaling] Connecting to signaling broker: ${brokerUrl}`);

    const client = mqtt.connect(brokerUrl, {
      clientId: `sv_pc_${this.serverPublicKey.slice(0, 8)}_${Date.now()}`,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 5000
    });

    this.mqttClient = client;

    const offerTopic = `streamvilla/${this.serverPublicKey}/offer`;
    const candidateTopic = `streamvilla/${this.serverPublicKey}/candidate`;

    client.on('connect', () => {
      console.log(`[WebRTC Signaling] Connected to signaling broker! Ready for browser direct connections.`);
      client.subscribe([offerTopic, candidateTopic], { qos: 0 }, (err) => {
        if (err) {
          console.warn('[WebRTC Signaling] Subscription error:', err.message);
        }
      });
    });

    client.on('message', (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        const sessionId = msg.sessionId;
        if (!sessionId) return;

        if (topic === offerTopic && msg.type === 'offer') {
          this.handleOffer(sessionId, msg);
        } else if (topic === candidateTopic && msg.type === 'candidate') {
          this.handleCandidate(sessionId, msg);
        }
      } catch (e) {
        console.warn('[WebRTC Signaling] Failed to parse message:', e.message);
      }
    });

    client.on('error', (err) => {
      console.warn(`[WebRTC Signaling] Broker error (${brokerUrl}):`, err.message);
    });

    client.on('offline', () => {
      console.log('[WebRTC Signaling] Signaling broker went offline. Retrying...');
    });
  }

  handleOffer(sessionId, msg) {
    console.log(`\n[WebRTC P2P] New incoming browser connection offer! Session: ${sessionId}`);

    // If an existing peer with this sessionId exists, clean it up
    if (this.activePeers.has(sessionId)) {
      try {
        this.activePeers.get(sessionId).pc.close();
      } catch (e) {}
      this.activePeers.delete(sessionId);
    }

    const peerInfo = {
      sessionId,
      pc: null,
      dc: null,
      hasRemoteDesc: false,
      pendingCandidates: [],
      createdAt: Date.now()
    };

    const pc = new nodeDataChannel.PeerConnection(sessionId, {
      iceServers: STUN_SERVERS
    });
    peerInfo.pc = pc;
    this.activePeers.set(sessionId, peerInfo);

    const answerTopic = `streamvilla/${this.serverPublicKey}/answer/${sessionId}`;
    const candidateTopic = `streamvilla/${this.serverPublicKey}/candidate/${sessionId}`;

    pc.onLocalDescription((sdp, type) => {
      if (this.mqttClient && this.mqttClient.connected) {
        this.mqttClient.publish(answerTopic, JSON.stringify({
          sessionId,
          type,
          sdp
        }));
      }
    });

    pc.onLocalCandidate((candidate, mid) => {
      if (this.mqttClient && this.mqttClient.connected) {
        this.mqttClient.publish(candidateTopic, JSON.stringify({
          sessionId,
          type: 'candidate',
          candidate,
          mid
        }));
      }
    });

    pc.onStateChange((state) => {
      console.log(`[WebRTC P2P] Session ${sessionId} state: ${state}`);
      if (state === 'closed' || state === 'failed') {
        this.cleanupSession(sessionId);
      }
    });

    pc.onDataChannel((dc) => {
      console.log(`[WebRTC P2P] DataChannel opened directly with browser! Session: ${sessionId}`);
      peerInfo.dc = dc;
      this.setupDataChannel(sessionId, dc);
    });

    try {
      pc.setRemoteDescription(msg.sdp, msg.type);
      peerInfo.hasRemoteDesc = true;

      // Apply any candidates that arrived prior to remote description
      if (peerInfo.pendingCandidates.length > 0) {
        for (const c of peerInfo.pendingCandidates) {
          try {
            pc.addRemoteCandidate(c.candidate, c.mid);
          } catch (e) {}
        }
        peerInfo.pendingCandidates = [];
      }
    } catch (err) {
      console.error(`[WebRTC P2P] Failed to set remote description for ${sessionId}:`, err);
    }
  }

  handleCandidate(sessionId, msg) {
    const peerInfo = this.activePeers.get(sessionId);
    if (!peerInfo) return;

    if (!peerInfo.hasRemoteDesc) {
      peerInfo.pendingCandidates.push(msg);
    } else {
      try {
        peerInfo.pc.addRemoteCandidate(msg.candidate, msg.mid);
      } catch (e) {
        console.warn(`[WebRTC Candidate Warning]:`, e.message);
      }
    }
  }

  setupDataChannel(sessionId, dc) {
    dc.onMessage((msg) => {
      if (typeof msg === 'string') {
        try {
          const reqData = JSON.parse(msg);
          if (reqData.url) {
            this.forwardRequestToLocalHttp(sessionId, dc, reqData);
          }
        } catch (e) {
          console.warn('[WebRTC DC] Failed to parse request:', e.message);
        }
      }
    });

    dc.onClosed(() => {
      console.log(`[WebRTC P2P] DataChannel closed for session ${sessionId}`);
      this.cleanupSession(sessionId);
    });

    dc.onError((err) => {
      console.warn(`[WebRTC P2P] DataChannel error on session ${sessionId}:`, err);
    });
  }

  forwardRequestToLocalHttp(sessionId, dc, reqData, attempt = 0) {
    const { id, method = 'GET', url, headers = {}, body = null } = reqData;

    const hostnames = ['localhost', '127.0.0.1'];
    const currentHost = hostnames[attempt % hostnames.length];

    // Filter headers that might conflict with localhost loopback
    const forwardHeaders = { ...headers, host: `${currentHost}:${this.localPort}` };
    delete forwardHeaders['content-length'];

    let bodyBuffer = null;
    if (body) {
      bodyBuffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
      forwardHeaders['content-length'] = bodyBuffer.length;
    }

    const httpReq = http.request({
      hostname: currentHost,
      port: this.localPort,
      path: url,
      method: method.toUpperCase(),
      headers: forwardHeaders
    }, (res) => {
      // 1. Send start header packet
      try {
        dc.sendMessage(JSON.stringify({
          id,
          type: 'start',
          statusCode: res.statusCode,
          headers: res.headers
        }));
      } catch (err) {
        console.warn('[WebRTC DC] Failed to send start packet:', err.message);
        return;
      }

      const idBuf = Buffer.from(id, 'utf8');
      const prefix = Buffer.from([idBuf.length]);
      const headerPrefix = Buffer.concat([prefix, idBuf]);

      // 2. Stream response data in slices <= MAX_CHUNK_SIZE
      res.on('data', (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          const sliceEnd = Math.min(offset + MAX_CHUNK_SIZE, chunk.length);
          const slice = chunk.slice(offset, sliceEnd);
          const payload = Buffer.concat([headerPrefix, slice]);

          try {
            dc.sendMessageBinary(payload);
          } catch (e) {
            console.warn('[WebRTC DC] Write error:', e.message);
            break;
          }

          offset = sliceEnd;
        }
      });

      // 3. Send end packet
      res.on('end', () => {
        try {
          dc.sendMessage(JSON.stringify({
            id,
            type: 'end'
          }));
        } catch (e) {}
      });
    });

    httpReq.on('error', (err) => {
      if (err.code === 'ECONNREFUSED' && attempt < hostnames.length - 1) {
        console.warn(`[WebRTC HTTP Forward] ${currentHost} refused connection, retrying with ${hostnames[attempt + 1]}...`);
        return this.forwardRequestToLocalHttp(sessionId, dc, reqData, attempt + 1);
      }
      console.warn(`[WebRTC HTTP Forward Error] ${url}:`, err.message);
      try {
        dc.sendMessage(JSON.stringify({
          id,
          type: 'error',
          error: err.message
        }));
      } catch (e) {}
    });

    if (bodyBuffer) {
      httpReq.write(bodyBuffer);
    }
    httpReq.end();
  }

  cleanupSession(sessionId) {
    const peer = this.activePeers.get(sessionId);
    if (peer) {
      try { peer.pc.close(); } catch (e) {}
      this.activePeers.delete(sessionId);
    }
  }

  stop() {
    this.isRunning = false;
    for (const [id, peer] of this.activePeers.entries()) {
      try { peer.pc.close(); } catch (e) {}
    }
    this.activePeers.clear();

    if (this.mqttClient) {
      try { this.mqttClient.end(); } catch (e) {}
      this.mqttClient = null;
    }
    console.log('[WebRTC P2P] WebRTC server stopped.');
  }
}

module.exports = new WebRtcServer();
