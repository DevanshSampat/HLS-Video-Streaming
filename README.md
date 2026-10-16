# HLS Video Streaming with P2P Hole Punching

A decentralized, end-to-end encrypted **HLS (HTTP Live Streaming) Video Server** that traverses Network Address Translation (NAT) and stateful firewalls across the globe using **HyperDHT** (the core technology by [Holepunch](https://holepunch.to)).

Stream your PC video library anywhere in the world **without port forwarding**, **without static IPs**, **without dynamic DNS**, and **without third-party relay servers**.

---

## ⚡ How It Works

```
┌─────────────────────────────────┐                 ┌─────────────────────────────────┐
│     Client (Anywhere on Earth)  │                 │     Host Server (Home PC / Mac) │
│                                 │                 │                                 │
│  [ Chrome / Safari / VLC / App ]│                 │   [ Express.js Video Server ]   │
│               │                 │                 │               ▲                 │
│               ▼                 │                 │               │                 │
│     [ client.js Proxy ]         │                 │      [ server.js Server ]       │
│               │                 │                 │               │                 │
│               ▼                 │                 │               ▼                 │
│     [ Local HyperDHT Node ]     │◄───────┬───────►│     [ Local HyperDHT Node ]     │
└─────────────────────────────────┘        │        └─────────────────────────────────┘
                                           ▼
                              [ HyperDHT Public Commons ]
                                Distributed Hash Table
                             (Coordinates UDP Hole-Punch)
```

1. **Decentralized Coordination**: The server announces its cryptographic public key (Ed25519) to the HyperDHT distributed network.
2. **NAT Traversal & Hole Punching**: When a client requests a connection, HyperDHT coordinates simultaneous UDP hole-punching across routers, CGNATs (Carrier-Grade NAT), and corporate firewalls.
3. **End-to-End Encryption**: Once hole-punched, an encrypted [Noise Protocol](http://noiseprotocol.org/) duplex stream (`NoiseSecretStream`) is established directly peer-to-peer.
4. **Transparent HTTP/HLS Streaming**: Incoming DHT streams are piped directly into Node's `http.Server`, allowing all HLS playlists (`.m3u8`), transcoding segments (`.ts`), and Express APIs to flow seamlessly.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Streaming Server
```bash
npm start
```

On startup, the server prints your **Global DHT Key** (64 hex characters):
```
══════════════════════════════════════════════════════════════════════════
  🚀 P2P HOLE-PUNCHED VIDEO STREAMING SERVER IS ONLINE (HYPERDHT)
══════════════════════════════════════════════════════════════════════════
  🔒 Protocol:        HyperDHT (Noise Protocol + UDP Hole-Punching)
  🌍 Traversal:       Works across global NATs, firewalls & CGNAT
  🔑 Global DHT Key:  73cd0b497addc28ee91b25f8319201c06dc12c7c11a1a611b7bb3c6ce79ec93a
  💻 Local PC:        http://localhost:9000
  📶 Local Wi-Fi:     http://192.168.1.100:9000
══════════════════════════════════════════════════════════════════════════
```

> **Note:** The server persists its keypair in `dht-key.json` so your server address remains constant across reboots.

---

## 📡 Connecting from Across the Globe

Share your **Server Public Key** with your remote device. All you need is `client.js`.

### Option A: Stream in Any Browser or Video Player (Proxy Bridge)
On the client machine (laptop, PC, Mac, or phone):
```bash
node client.js <SERVER_PUBLIC_KEY> --proxy 8080
```
Then open:
- **`http://localhost:8080/videos`** to browse your media library.
- Play video streams directly in Chrome, Firefox, Safari, VLC, or any HLS player!

### Option B: Quick CLI Video Library Listing
```bash
node client.js <SERVER_PUBLIC_KEY> /videos
```

### Option C: Check Server Status
```bash
node client.js <SERVER_PUBLIC_KEY> /api/status
```

### Option D: P2P Round-Trip Latency Benchmark
```bash
node client.js <SERVER_PUBLIC_KEY> --ping
```

---

## 🧪 Automated P2P Verification Test

Run the end-to-end verification test suite:
```bash
npm run test:p2p
```

This tests:
1. HyperDHT server initialization and network bootstrap.
2. Direct P2P GET request over hole-punched stream.
3. Direct P2P GET `/videos` endpoint over hole-punched stream.
4. Local TCP/HTTP browser proxy bridge relay.
