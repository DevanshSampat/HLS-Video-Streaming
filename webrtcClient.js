/**
 * WebRTC Browser Client for StreamVilla
 * Connects directly to StreamVilla PC server via WebRTC DataChannel (UDP Hole-Punching)
 * Zero local proxy servers required. Works in all modern browsers (Chrome, Safari, Firefox, Edge, iOS, Android).
 */

import mqtt from 'mqtt';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

const SIGNALING_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt'
];

class WebRtcClient {
  constructor() {
    this.dhtKey = null;
    this.sessionId = null;
    this.pc = null;
    this.dc = null;
    this.mqttClient = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'error'
    this.errorMsg = '';
    this.listeners = new Set();
    this.pendingRequests = new Map(); // reqId -> { resolve, reject, chunks, responseInfo, timeout }
    this.reqCounter = 0;
    this.pendingCandidates = [];
    this.hasRemoteDescription = false;
  }

  isSupported() {
    return typeof window !== 'undefined' && 'RTCPeerConnection' in window;
  }

  onStatusChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setStatus(status, errorMsg = '') {
    this.status = status;
    this.errorMsg = errorMsg;
    for (const listener of this.listeners) {
      try {
        listener(status, errorMsg);
      } catch (e) {
        console.error('Error in WebRTC status listener:', e);
      }
    }
  }

  async connect(targetDhtKey) {
    if (!targetDhtKey || !/^[0-9a-fA-F]{64}$/.test(targetDhtKey)) {
      this.setStatus('error', 'Invalid 64-character DHT key.');
      return false;
    }

    if (this.status === 'connected' && this.dhtKey === targetDhtKey && this.dc && this.dc.readyState === 'open') {
      return true;
    }

    this.disconnect();
    this.dhtKey = targetDhtKey;
    this.sessionId = `br_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.setStatus('connecting');
    this.hasRemoteDescription = false;
    this.pendingCandidates = [];

    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved && this.status !== 'connected') {
          resolved = true;
          this.setStatus('error', 'WebRTC connection to PC timed out. Make sure StreamVilla is running on your PC.');
          resolve(false);
        }
      }, 15000);

      this.initPeerConnection(resolve, () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
        }
      });
    });
  }

  initPeerConnection(finalResolve, markResolved) {
    try {
      this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    } catch (e) {
      markResolved();
      this.setStatus('error', `WebRTC not supported on this device: ${e.message}`);
      finalResolve(false);
      return;
    }

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log(`[WebRTC P2P] Connection state: ${state}`);
      if (state === 'failed') {
        this.setStatus('error', 'P2P NAT traversal failed.');
        markResolved();
        finalResolve(false);
      } else if (state === 'disconnected' || state === 'closed') {
        this.setStatus('disconnected');
      }
    };

    this.connectSignaling(0, finalResolve, markResolved);
  }

  connectSignaling(brokerIdx, finalResolve, markResolved) {
    const brokerUrl = SIGNALING_BROKERS[brokerIdx % SIGNALING_BROKERS.length];
    console.log(`[WebRTC Signaling] Connecting to broker: ${brokerUrl}`);

    const mqttClient = mqtt.connect(brokerUrl, {
      clientId: `sv_browser_${this.sessionId}`,
      clean: true,
      connectTimeout: 8000
    });
    this.mqttClient = mqttClient;

    const answerTopic = `streamvilla/${this.dhtKey}/answer/${this.sessionId}`;
    const pcCandidateTopic = `streamvilla/${this.dhtKey}/candidate/${this.sessionId}`;
    const offerTopic = `streamvilla/${this.dhtKey}/offer`;
    const browserCandidateTopic = `streamvilla/${this.dhtKey}/candidate`;

    mqttClient.on('connect', async () => {
      console.log('[WebRTC Signaling] Connected to signaling broker. Subscribing to PC responses...');
      mqttClient.subscribe([answerTopic, pcCandidateTopic], { qos: 0 }, async (err) => {
        if (err) {
          console.warn('[WebRTC Signaling] Subscribe error:', err);
          return;
        }

        try {
          // Listen for local ICE candidates to forward to PC
          this.pc.onicecandidate = (event) => {
            if (event.candidate && mqttClient.connected) {
              mqttClient.publish(browserCandidateTopic, JSON.stringify({
                sessionId: this.sessionId,
                type: 'candidate',
                candidate: event.candidate.candidate,
                mid: event.candidate.sdpMid
              }));
            }
          };

          // Create DataChannel with protocol 'streamvilla-data'
          this.dc = this.pc.createDataChannel('streamvilla-data', {
            ordered: true
          });
          this.dc.binaryType = 'arraybuffer';

          this.dc.onopen = () => {
            console.log('⚡ [WebRTC P2P] Direct DataChannel OPEN with PC server!');
            markResolved();
            this.setStatus('connected');
            finalResolve(true);

            // Close signaling MQTT connection once direct WebRTC is established
            if (this.mqttClient) {
              try {
                this.mqttClient.end();
              } catch (e) {}
              this.mqttClient = null;
            }
          };

          this.dc.onclose = () => {
            console.log('🔌 [WebRTC P2P] DataChannel closed.');
            this.setStatus('disconnected');
          };

          this.dc.onerror = (err) => {
            console.warn('⚠️ [WebRTC P2P] DataChannel error:', err);
          };

          this.dc.onmessage = (event) => {
            this.handleIncomingMessage(event.data);
          };

          // Create Offer
          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);

          console.log(`[WebRTC Signaling] Sending SDP offer for session ${this.sessionId}...`);
          mqttClient.publish(offerTopic, JSON.stringify({
            sessionId: this.sessionId,
            type: 'offer',
            sdp: offer.sdp
          }));
        } catch (offerErr) {
          console.error('[WebRTC Signaling] Failed to create offer:', offerErr);
          markResolved();
          this.setStatus('error', `Failed to create WebRTC offer: ${offerErr.message}`);
          finalResolve(false);
        }
      });
    });

    mqttClient.on('message', async (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg.sessionId !== this.sessionId) return;

        if (topic === answerTopic && msg.type === 'answer') {
          console.log('[WebRTC Signaling] Received SDP answer from PC!');
          await this.pc.setRemoteDescription(new RTCSessionDescription({
            type: 'answer',
            sdp: msg.sdp
          }));
          this.hasRemoteDescription = true;

          // Apply buffered candidates
          for (const c of this.pendingCandidates) {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate({
                candidate: c.candidate,
                sdpMid: c.mid
              }));
            } catch (candErr) {}
          }
          this.pendingCandidates = [];
        } else if (topic === pcCandidateTopic && msg.type === 'candidate') {
          if (!this.hasRemoteDescription) {
            this.pendingCandidates.push(msg);
          } else {
            try {
              await this.pc.addIceCandidate(new RTCIceCandidate({
                candidate: msg.candidate,
                sdpMid: msg.mid
              }));
            } catch (candErr) {}
          }
        }
      } catch (err) {
        console.warn('[WebRTC Signaling] Error processing message:', err);
      }
    });

    mqttClient.on('error', (err) => {
      console.warn('[WebRTC Signaling] MQTT error:', err);
    });
  }

  handleIncomingMessage(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        const req = this.pendingRequests.get(msg.id);
        if (!req) return;

        if (msg.type === 'start') {
          req.responseInfo = {
            statusCode: msg.statusCode || 200,
            headers: msg.headers || {}
          };
        } else if (msg.type === 'end') {
          clearTimeout(req.timeout);
          this.pendingRequests.delete(msg.id);

          // Concatenate all chunks into a single Uint8Array
          let totalLen = 0;
          for (const c of req.chunks) totalLen += c.byteLength;
          const merged = new Uint8Array(totalLen);
          let offset = 0;
          for (const c of req.chunks) {
            merged.set(new Uint8Array(c), offset);
            offset += c.byteLength;
          }

          const response = {
            status: req.responseInfo ? req.responseInfo.statusCode : 200,
            ok: (req.responseInfo ? req.responseInfo.statusCode : 200) >= 200 && (req.responseInfo ? req.responseInfo.statusCode : 200) < 300,
            headers: req.responseInfo ? req.responseInfo.headers : {},
            arrayBuffer: async () => merged.buffer,
            text: async () => new TextDecoder().decode(merged),
            json: async () => JSON.parse(new TextDecoder().decode(merged)),
            data: merged
          };

          req.resolve(response);
        } else if (msg.type === 'error') {
          clearTimeout(req.timeout);
          this.pendingRequests.delete(msg.id);
          req.reject(new Error(msg.error || 'Server error'));
        }
      } catch (e) {
        console.warn('[WebRTC Data] Failed to parse text frame:', e);
      }
    } else if (data instanceof ArrayBuffer) {
      // Binary data: [ 1 byte: id length N ][ N bytes: id string ][ payload ]
      const view = new Uint8Array(data);
      const idLen = view[0];
      const id = new TextDecoder().decode(view.subarray(1, 1 + idLen));
      const payload = data.slice(1 + idLen);

      const req = this.pendingRequests.get(id);
      if (req) {
        req.chunks.push(payload);
      }
    }
  }

  /**
   * Perform an HTTP request over the WebRTC DataChannel
   * @param {string} url Request URL path (e.g. '/videos' or '/stream/...')
   * @param {object} options { method, headers, body, timeoutMs }
   * @returns {Promise<Response>}
   */
  request(url, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.dc || this.dc.readyState !== 'open') {
        return reject(new Error('WebRTC DataChannel is not open'));
      }

      const reqId = `r_${++this.reqCounter}_${Date.now()}`;
      const timeoutMs = options.timeoutMs || 30000;

      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(reqId)) {
          this.pendingRequests.delete(reqId);
          reject(new Error(`WebRTC request timed out for ${url}`));
        }
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        chunks: [],
        responseInfo: null,
        timeout
      });

      // Strip any baseUrl to get pure path
      let path = url;
      try {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          const parsed = new URL(url);
          path = parsed.pathname + parsed.search;
        }
      } catch (e) {}

      const reqPayload = {
        id: reqId,
        method: options.method || 'GET',
        url: path,
        headers: options.headers || {},
        body: options.body || null
      };

      try {
        this.dc.send(JSON.stringify(reqPayload));
      } catch (sendErr) {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        reject(sendErr);
      }
    });
  }

  /**
   * Helper fetch that matches window.fetch API
   */
  async fetch(url, options = {}) {
    return this.request(url, options);
  }

  /**
   * Create an Hls.js compatible custom Loader class
   */
  createHlsLoader() {
    const client = this;

    return class WebRtcHlsLoader {
      constructor(config) {
        this.config = config;
        this.stats = {
          trequest: 0,
          tfirst: 0,
          tload: 0,
          loaded: 0,
          total: 0
        };
      }

      destroy() {}

      abort() {}

      load(context, config, callbacks) {
        this.stats.trequest = performance.now();

        client.request(context.url)
          .then(async (res) => {
            this.stats.tfirst = performance.now();
            this.stats.tload = performance.now();

            let data;
            if (context.responseType === 'arraybuffer') {
              data = await res.arrayBuffer();
              this.stats.loaded = data.byteLength;
              this.stats.total = data.byteLength;
            } else {
              data = await res.text();
              this.stats.loaded = data.length;
              this.stats.total = data.length;
            }

            callbacks.onSuccess({
              url: context.url,
              data: data
            }, this.stats, context);
          })
          .catch((err) => {
            console.warn(`[WebRTC HLS Loader] Error loading ${context.url}:`, err.message);
            callbacks.onError(err, context);
          });
      }
    };
  }

  disconnect() {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timeout);
      req.reject(new Error('WebRTC disconnected'));
    }
    this.pendingRequests.clear();

    if (this.dc) {
      try { this.dc.close(); } catch (e) {}
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) {}
      this.pc = null;
    }
    if (this.mqttClient) {
      try { this.mqttClient.end(); } catch (e) {}
      this.mqttClient = null;
    }

    this.setStatus('disconnected');
  }
}

export const webrtcClient = new WebRtcClient();
export default webrtcClient;
