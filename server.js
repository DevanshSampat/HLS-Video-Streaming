const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const si = require("systeminformation");
const crypto = require("crypto");
const { exec } = require("child_process");
const { execSync } = require("child_process");
const e = require("express");
const http = require("http");
const { default: axios } = require("axios");
const HyperDHT = require("hyperdht");
const httpPort = 6969;
let serverIpAddressResponse;
let lastRequestTime = {};
const deletionInterval = 2 * 60 * 60 * 1000;
const currentlyProcessingChunks = {};
const cachedPreferredQuality = {};
let isCameraFeedAvailable = false;
let recordingsFetchingInterval = 60000;
let cachedRecordings = [];
const peerIpRegistry = {};

// -------------------------------------------------------------
// HyperDHT Hole-Punching & Key Management
// -------------------------------------------------------------
const KEY_FILE = path.join(__dirname, "dht-key.json");
const serverStartTime = Date.now();
const activePeers = new Map();

function loadOrCreateKeyPair() {
    if (fs.existsSync(KEY_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
            if (data.publicKey && data.secretKey) {
                return {
                    publicKey: Buffer.from(data.publicKey, "hex"),
                    secretKey: Buffer.from(data.secretKey, "hex")
                };
            }
        } catch (e) {
            console.warn("[Warning] Corrupt dht-key.json, generating fresh keypair...");
        }
    }

    const keyPair = HyperDHT.keyPair();
    fs.writeFileSync(KEY_FILE, JSON.stringify({
        publicKey: keyPair.publicKey.toString("hex"),
        secretKey: keyPair.secretKey.toString("hex"),
        createdAt: new Date().toISOString()
    }, null, 2));

    return keyPair;
}

const keyPair = loadOrCreateKeyPair();
const serverPublicKey = keyPair.publicKey.toString("hex");

const migrateToNewWatchDataSystem = () => {
    if (!fs.existsSync(path.join(__dirname, "user_watch_data"))) return;
    const userIds = fs.readdirSync(path.join(__dirname, "user_watch_data"));
    userIds.forEach(userId => {
        if (userId.endsWith(".json")) {
            console.log(`Migrating user watch data for: ${userId.split('.')[0]}`);
            const userData = JSON.parse(fs.readFileSync(path.join(__dirname, "user_watch_data", userId), "utf8"));
            Object.keys(userData).forEach(key => {
                axios.post("http://localhost:9090/watch-details", {
                    firebaseUid: userId.split('.')[0],
                    videoId: key,
                    dataToPut: userData[key]
                });
            })
            fs.unlinkSync(path.join(__dirname, "user_watch_data", userId));
        }
    })
}

migrateToNewWatchDataSystem();

const fetchRecordingsPeriodically = async () => {
    try {
        const backendRes = await axios.get("http://localhost:5001/api/recordings");
        if (backendRes.data && backendRes.data.recordings) {
            isCameraFeedAvailable = true;
            cachedRecordings = backendRes.data.recordings
                .map((rec) => ({
                    name: rec.filename,
                    path: `recordings/${rec.filename}`,
                    downloadPath: `recordings/download?id=${rec.filename}`,
                    sizeMB: rec.sizeMB,
                    alertExists: rec.alertExists,
                    modifiedAt: rec.modifiedAt,
                    isRecording: true,
                    subtitle: false,
                }))
                .sort((a, b) =>
                    b.name.toLowerCase().localeCompare(a.name.toLowerCase()),
                );
        }
    } catch (err) {
        isCameraFeedAvailable = false;
        cachedRecordings = [];
    }
};

fetchRecordingsPeriodically();
setInterval(fetchRecordingsPeriodically, recordingsFetchingInterval);

let streamLocally = false;
if (fs.existsSync(path.join(__dirname, "userPreferences.json"))) {
    streamLocally = JSON.parse(
        fs.readFileSync(path.join(__dirname, "userPreferences.json"), "utf8"),
    ).streamLocally;
}

const deleteFolderRecursive = (dirPath) => {
    if (fs.existsSync(dirPath)) {
        fs.readdirSync(dirPath).forEach(function (file) {
            var curPath = dirPath + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) {
                // recurse
                deleteFolderRecursive(curPath);
            } else {
                // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(dirPath);
    }
};

// deleteFolderRecursive(path.join(__dirname, "streams"));

const deleteChunkedFiles = () => {
    if (!fs.existsSync(path.join(__dirname, "streams"))) return;
    const files = fs.readdirSync(path.join(__dirname, "streams"));
    files.forEach((f) => {
        if ((lastRequestTime[f] || 0) + deletionInterval > Date.now()) {
            return;
        }
        const chunks = fs
            .readdirSync(path.join(__dirname, "streams", f))
            .filter((c) => c.endsWith(".ts"));
        if (chunks.length > 0) console.log(`Deleting chunks for video: ${f}`);
        for (let i = 0; i < chunks.length; i++) {
            fs.unlinkSync(path.join(__dirname, "streams", f, chunks[i]));
        }
    });
};

setInterval(deleteChunkedFiles, deletionInterval);
// deleteChunkedFiles();

const ffmpeg = require("fluent-ffmpeg");
let ffmpegBinaryPath = "ffmpeg";
let ffprobeBinaryPath = "ffprobe";
if (fs.existsSync(path.join(__dirname, "ffmpeg/bin/ffmpeg.exe"))) {
    ffmpegBinaryPath = path.join(__dirname, "ffmpeg/bin/ffmpeg.exe");
    ffprobeBinaryPath = path.join(__dirname, "ffmpeg/bin/ffprobe.exe");
} else if (fs.existsSync(path.join(__dirname, "../ffmpeg/bin/ffmpeg.exe"))) {
    ffmpegBinaryPath = path.join(__dirname, "../ffmpeg/bin/ffmpeg.exe");
    ffprobeBinaryPath = path.join(__dirname, "../ffmpeg/bin/ffprobe.exe");
} else if (fs.existsSync(path.join(__dirname, "ffmpeg_path.txt"))) {
    ffmpegBinaryPath = fs
        .readFileSync(path.join(__dirname, "ffmpeg_path.txt"), "utf8")
        .trim()
        .replace(/"/g, "");
    ffprobeBinaryPath = ffmpegBinaryPath.replace("ffmpeg", "ffprobe");
} else if (fs.existsSync(path.join(__dirname, "../ffmpeg_path.txt"))) {
    ffmpegBinaryPath = fs
        .readFileSync(path.join(__dirname, "../ffmpeg_path.txt"), "utf8")
        .trim()
        .replace(/"/g, "");
    ffprobeBinaryPath = ffmpegBinaryPath.replace("ffmpeg", "ffprobe");
}
ffmpeg.setFfmpegPath(ffmpegBinaryPath);
ffmpeg.setFfprobePath(ffprobeBinaryPath);

const ALL_VIDEO_QUALITIES = [
    { height: 144, bitrate: "200k" },
    { height: 240, bitrate: "400k" },
    { height: 360, bitrate: "800k" },
    { height: 480, bitrate: "1200k" },
    { height: 720, bitrate: "2500k" },
    { height: 1080, bitrate: "5000k" },
    { height: 1440, bitrate: "8000k" },
    { height: 2160, bitrate: "15000k" },
];

let globalUrl = "";
let localIpAddress = "no address";

const fileIdPathMap = {};

const nodePath = fs.existsSync(path.join(__dirname, "../node_path.txt"))
    ? fs.readFileSync(path.join(__dirname, "../node_path.txt"), "utf8")
    : "node";

const app = express();
const PORT = 9000;

app.use(cors());

// Request logging middleware distinguishing Local vs P2P
app.use((req, res, next) => {
    const start = Date.now();
    const clientIdentifier = (req.socket && req.socket.remoteAddress) || req.headers["x-forwarded-for"] || "local";
    res.on("finish", () => {
        const duration = Date.now() - start;
        const isP2P = typeof clientIdentifier === "string" && clientIdentifier.length === 64;
        const sourceLabel = isP2P ? `[P2P ${clientIdentifier.slice(0, 8)}...]` : `[Local ${clientIdentifier}]`;
        if (req.originalUrl && !req.originalUrl.endsWith(".ts")) {
            console.log(`${sourceLabel} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);
        }
    });
    next();
});

const httpServer = http.createServer(app);
httpServer.keepAliveTimeout = 600000;
httpServer.headersTimeout = 0;
httpServer.requestTimeout = 0;
httpServer.timeout = 0;

// Initialize HyperDHT node and P2P Server
const dht = new HyperDHT({ port: 0 });
const dhtServer = dht.createServer({
    firewall(remotePublicKey, remoteHandshakePayload) {
        const peerIdHex = remotePublicKey.toString('hex');
        const physicalIp = remoteHandshakePayload.addresses4?.[0].host; // The actual network IP

        // Save it to your global registry
        peerIpRegistry[peerIdHex] = physicalIp;

        return false; // False means "Allow connection"
    }
}, (socket) => {
    const remoteKey = socket.remotePublicKey ? socket.remotePublicKey.toString("hex") : `peer-${Date.now()}`;

    activePeers.set(remoteKey, {
        socket,
        connectedAt: Date.now()
    });

    // Polyfill / adapt NoiseSecretStream to satisfy Node's http.Server
    if (!socket.setNoDelay) socket.setNoDelay = () => socket;
    if (!socket.setKeepAlive) socket.setKeepAlive = () => socket;
    if (!socket.destroySoon) socket.destroySoon = () => socket.end();
    if (!socket.setTimeout) socket.setTimeout = (ms, cb) => { if (cb) socket.on('timeout', cb); return socket; };
    if (!socket.unref) socket.unref = () => socket;
    if (!socket.ref) socket.ref = () => socket;
    socket.cork = () => { };
    socket.uncork = () => { };

    const origWrite = socket.write.bind(socket);
    socket.write = function (data, encoding, cb) {
        if (typeof encoding === 'function') {
            cb = encoding;
            encoding = null;
        }
        const ret = origWrite(data);
        if (typeof cb === 'function') {
            process.nextTick(cb);
        }
        return ret;
    };
    if (!socket.remotePort) socket.remotePort = 0;
    if (!socket.localPort) socket.localPort = PORT;
    if (!socket.localAddress) socket.localAddress = "127.0.0.1";
    socket.remoteAddress = remoteKey;
    socket.encrypted = true;

    console.log(`\n[P2P Hole-Punch] Connection established from peer: ${remoteKey}`);

    socket.on("close", () => {
        activePeers.delete(remoteKey);
        console.log(`[P2P Hole-Punch] Peer disconnected: ${remoteKey}`);
    });

    socket.on("error", (err) => {
        const normalCodes = ['ECONNRESET', 'PREMATURE_CLOSE', 'ERR_STREAM_PREMATURE_CLOSE', 'ECANCELED', 'EPIPE'];
        const isNormal = err && (
            normalCodes.includes(err.code) ||
            (err.message && (err.message.includes('closed') || err.message.includes('Premature close')))
        );
        if (!isNormal) {
            console.warn(`[P2P Stream Warning] Peer ${remoteKey.slice(0, 8)}:`, err.message);
        }
    });

    // Hand over the hole-punched duplex stream to Node's HTTP Server
    httpServer.emit("connection", socket);
});

http
    .createServer((req, res) => {
        if (req.url == "/server-ip-address-for-streamvilla") {
            if (globalUrl !== "") {
                res.end(globalUrl);
            }
            serverIpAddressResponse = res;
        } else {
            res.end("no");
        }
    })
    .listen(httpPort);

const files = fs.existsSync(path.join(__dirname, "streams"))
    ? fs.readdirSync(path.join(__dirname, "streams"))
    : [];
files.forEach((f) => {
    if (!fs.existsSync(path.join(__dirname, "streams", f, "createdAt.txt"))) {
        deleteFolderRecursive(path.join(__dirname, "streams", f));
        console.log(`🗑️  Deleted incomplete stream directory: ${f}`);
    }
});

const getFolderPathToCastVideos = () => {
    if (fs.existsSync(path.join(__dirname, "path.txt"))) {
        return fs
            .readFileSync(path.join(__dirname, "path.txt"), "utf8")
            .replaceAll("\\", "/");
    }

    let cmd = "";
    if (process.platform === "win32") {
        cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Video Folder'; if($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`;
    } else if (process.platform === "darwin") {
        cmd = `osascript -e 'POSIX path of (choose folder with prompt "Select Video Folder")'`;
    } else {
        console.error("Folder picker is not supported on this platform.");
        return null;
    }

    try {
        const result = execSync(cmd, { encoding: "utf8" }).trim();
        return result?.replaceAll("\\", "/");
    } catch (err) {
        console.error("User closed the dialog or an error occurred.");
        return null;
    }
};

deleteFolderRecursive(path.join(__dirname, "subtitles"));

const exploreFolderForVideos = (folderPath) => {
    if (!fs.existsSync(folderPath)) {
        console.error("Folder does not exist:", folderPath);
        return;
    }
    const files = fs.readdirSync(folderPath);
    for (let i = 0; i < files.length; i++) {
        const fullPath = path.join(folderPath, files[i]);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            exploreFolderForVideos(fullPath);
        } else {
            const ext = path.extname(files[i]).toLowerCase();
            if (
                ext === ".mp4" ||
                ext === ".mkv" ||
                ext === ".flv" ||
                ext === ".mov" ||
                ext === ".MOV"
            ) {
                const fileId = crypto.createHash("md5").update(fullPath).digest("hex");
                fileIdPathMap[fileId] = fullPath;
            }
        }
    }
};

// Serve static frontend files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// -------------------------------------------------------------
// P2P Hole-Punching & Health Diagnostics API Endpoints
// -------------------------------------------------------------
app.get("/api/status", (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: "online",
        service: "streamvilla-hls-video-streaming",
        protocol: "hyperdht/holepunch",
        publicKey: serverPublicKey,
        startTime: serverStartTime,
        uptimeSeconds: Math.floor((Date.now() - serverStartTime) / 1000),
        peers: {
            active: activePeers.size,
            connectedKeys: Array.from(activePeers.keys()).map((k) => k.slice(0, 16) + "...")
        },
        memory: {
            rssMB: Math.round(mem.rss / (1024 * 1024)),
            heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024))
        },
        traversal: {
            holePunching: "active",
            bootstrapped: true,
            bootstrapNodesCount: 3
        },
        localPort: PORT,
        nodeVersion: process.version
    });
});

app.get("/api/ping", (req, res) => {
    res.json({
        pong: true,
        serverTime: Date.now(),
        iso: new Date().toISOString(),
        peer: (req.socket && req.socket.remoteAddress) || "local"
    });
});

app.all("/api/echo", (req, res) => {
    res.json({
        receivedMethod: req.method,
        headers: req.headers,
        query: req.query,
        body: req.body,
        client: (req.socket && req.socket.remoteAddress) || "local",
        timestamp: Date.now()
    });
});

app.get("/api/peers", (req, res) => {
    const peerList = [];
    for (const [key, info] of activePeers.entries()) {
        peerList.push({
            peerKey: key,
            connectedAt: info.connectedAt,
            durationSeconds: Math.floor((Date.now() - info.connectedAt) / 1000)
        });
    }
    res.json({ count: peerList.length, peers: peerList });
});

function filterManifest(originalM3u8, maxQuality) {
    const lines = originalM3u8.split("\n");
    let output = [];
    let finalLine = "";
    let keepNextUri = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith("#EXT-X-STREAM-INF")) {
            // It's a variant stream. Check resolution.
            // Regex to find RESOLUTION=WxH and capture H
            const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);

            if (resMatch && resMatch[1]) {
                const height = parseInt(resMatch[1], 10);
                if (height <= maxQuality) {
                    finalLine = line + "\n" + lines[++i];
                    keepNextUri = false;
                }
            } else {
                // If no resolution tag, standard says keep it or decide a default.
                // Usually safe to keep if you can't determine quality.
                finalLine = line;
                keepNextUri = true;
            }
        } else if (line.startsWith("#")) {
            // Other global tags (EXTM3U, EXT-X-MEDIA, etc.) - keep them
            output.push(line);
        } else {
            // This is a URI line. Only keep if the preceding INF tag passed the filter.
            if (keepNextUri) {
                output.push(line);
            }
        }
    }
    output.push(finalLine);

    return output.join("\n");
}

async function prepareAllM3u8Files() {
    let forceStreamSingleQuality = false;
    if (fs.existsSync(path.join(__dirname, "userPreferences.json"))) {
        const userPreferences = JSON.parse(
            fs.readFileSync(path.join(__dirname, "userPreferences.json"), "utf8"),
        );
        forceStreamSingleQuality = userPreferences.forceStreamSingleQuality || false;
    }
    if (forceStreamSingleQuality) {
        console.log("No need to prepare manifest, single quality is forced")
        return;
    }

    console.log("⚙️  Preparing HLS m3u8 playlist files...");
    const keys = Object.keys(fileIdPathMap);
    for (const id of keys) {
        const videoPath = fileIdPathMap[id];
        const streamDir = path.join(__dirname, "streams", id);
        const masterPlaylistPath = path.join(streamDir, "master.m3u8");

        if (fs.existsSync(masterPlaylistPath)) {
            // console.log(`⏩ Playlists already exist for video: ${path.basename(videoPath)}`);
            continue;
        }

        fs.mkdirSync(streamDir, { recursive: true });

        try {
            const metadata = await new Promise((resolve, reject) => {
                ffmpeg.ffprobe(videoPath, (err, meta) => {
                    if (err) reject(err);
                    else resolve(meta);
                });
            });

            const duration = metadata.format.duration;
            if (!duration) {
                throw new Error("Could not determine video duration");
            }

            const vStream = metadata.streams.find((s) => s.codec_type === "video");
            const aStreams = metadata.streams.filter((s) => s.codec_type === "audio");
            if (!vStream) {
                throw new Error("No video stream found");
            }

            const validQualities = ALL_VIDEO_QUALITIES.filter(
                (q) => q.height <= vStream.height,
            );
            if (
                validQualities.length === 0 ||
                validQualities[validQualities.length - 1].height !== vStream.height
            ) {
                validQualities.push({ height: vStream.height, bitrate: "2000k" });
            }

            const audioTracks = aStreams.map((s, i) => ({
                index: s.index,
                id: `audio_${i}`,
                lang: s.tags?.language || s.tags?.LANGUAGE || "und",
                name: s.tags?.title || s.tags?.language || `Track ${i + 1}`,
            }));

            // Save metadata for on-the-fly segment generation
            const metaJson = {
                sourcePath: videoPath,
                duration: duration,
                videoStreamIndex: vStream.index,
                videoCodec: vStream.codec_name,
                audioTracks: audioTracks,
                qualities: validQualities,
            };
            fs.writeFileSync(
                path.join(streamDir, "metadata.json"),
                JSON.stringify(metaJson, null, 2),
            );

            // Write master.m3u8
            let masterContent = "#EXTM3U\n#EXT-X-VERSION:3\n";
            audioTracks.forEach((t, i) => {
                const displayName =
                    t.name &&
                        t.lang &&
                        t.lang !== "und" &&
                        !t.name.toLowerCase().includes(t.lang.toLowerCase())
                        ? `${t.name} (${t.lang})`
                        : t.name;
                masterContent += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",LANGUAGE="${t.lang}",NAME="${displayName}",DEFAULT=${i === 0 ? "YES" : "NO"},AUTOSELECT=YES,URI="${t.id}.m3u8"\n`;
            });

            [...validQualities]
                .sort((a, b) => a.height - b.height)
                .forEach((q) => {
                    masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${(parseInt(q.bitrate) + 192) * 1000},RESOLUTION=1280x${q.height},AUDIO="stereo"\nvideo_${q.height}p.m3u8\n`;
                });
            fs.writeFileSync(masterPlaylistPath, masterContent);

            // Write audio playlists
            const segmentTime = 12;
            const segmentCount = Math.ceil(duration / segmentTime);

            audioTracks.forEach((t) => {
                let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n`;
                for (let i = 0; i < segmentCount; i++) {
                    let curDur = segmentTime;
                    if (i === segmentCount - 1) {
                        curDur = duration - i * segmentTime;
                    }
                    playlist += `#EXTINF:${curDur.toFixed(6)},\n${t.id}_${String(i).padStart(3, "0")}.ts\n`;
                }
                playlist += `#EXT-X-ENDLIST\n`;
                fs.writeFileSync(path.join(streamDir, `${t.id}.m3u8`), playlist);
            });

            // Write video playlists
            validQualities.forEach((q) => {
                const videoSegmentTime = 12;
                const videoSegmentCount = Math.ceil(duration / videoSegmentTime);
                let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${videoSegmentTime}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n`;
                for (let i = 0; i < videoSegmentCount; i++) {
                    let curDur = videoSegmentTime;
                    if (i === videoSegmentCount - 1) {
                        curDur = duration - i * videoSegmentTime;
                    }
                    playlist += `#EXTINF:${curDur.toFixed(6)},\nvideo_${q.height}p_${String(i).padStart(3, "0")}.ts\n`;
                }
                playlist += `#EXT-X-ENDLIST\n`;
                fs.writeFileSync(
                    path.join(streamDir, `video_${q.height}p.m3u8`),
                    playlist,
                );
            });

            fs.writeFileSync(path.join(streamDir, "createdAt.txt"), `${Date.now()}`);
            console.log(`✅ Prepared manifests for: ${path.basename(videoPath)}`);
        } catch (err) {
            console.error(
                `❌ Failed to prepare playlists for: ${path.basename(videoPath)}`,
                err,
            );
        }
    }
}

const activeTranscodes = {};
const transcodeQueue = [];
let activeTranscodeCount = 0;
const MAX_CONCURRENT = 2;

function runNextInQueue() {
    if (activeTranscodeCount >= MAX_CONCURRENT) return;
    if (transcodeQueue.length === 0) return;

    // Sort queue based on preferredQuality and current processing chunk
    transcodeQueue.sort((a, b) => {
        const aParsed = parseSegmentPath(a.filePath);
        const bParsed = parseSegmentPath(b.filePath);

        const aPref = aParsed
            ? cachedPreferredQuality[path.basename(path.dirname(a.filePath))]
            : null;
        const bPref = bParsed
            ? cachedPreferredQuality[path.basename(path.dirname(b.filePath))]
            : null;

        const aCurrentChunk =
            currentlyProcessingChunks[path.basename(path.dirname(a.filePath))] || 0;
        const bCurrentChunk =
            currentlyProcessingChunks[path.basename(path.dirname(b.filePath))] || 0;

        const aIsPreferred =
            aParsed &&
            aParsed.type === "video" &&
            aParsed.height === aPref &&
            aParsed.index >= aCurrentChunk - 10 &&
            aParsed.index < aCurrentChunk + 5;
        const bIsPreferred =
            bParsed &&
            bParsed.type === "video" &&
            bParsed.height === bPref &&
            bParsed.index >= bCurrentChunk - 10 &&
            bParsed.index < bCurrentChunk + 5;

        if (aIsPreferred && aParsed.index === aCurrentChunk) return -1;
        if (bIsPreferred && bParsed.index === bCurrentChunk) return 1;
        if (aIsPreferred && !bIsPreferred) return -1;
        if (!aIsPreferred && bIsPreferred) return 1;
        if (
            aParsed.index >= aCurrentChunk - 10 &&
            bParsed.index < bCurrentChunk - 10
        )
            return -1;
        if (
            aParsed.index < aCurrentChunk - 10 &&
            bParsed.index >= bCurrentChunk - 10
        )
            return 1;
        if (aParsed.index > bParsed.index) return 1;
        if (aParsed.index < bParsed.index) return -1;
        return 0;
    });

    const task = transcodeQueue.shift();
    activeTranscodeCount++;

    task.run().finally(() => {
        activeTranscodeCount--;
        runNextInQueue();
    });
}

function parseSegmentPath(filePath) {
    const fileName = path.basename(filePath);
    let match = fileName.match(/video_(\d+)p_(\d+)\.ts/);
    if (match) {
        return {
            type: "video",
            index: parseInt(match[2]),
            height: parseInt(match[1]),
        };
    }
    match = fileName.match(/audio_(\d+)_(\d+)\.ts/);
    if (match) {
        return {
            type: "audio",
            index: parseInt(match[2]),
            trackId: parseInt(match[1]),
        };
    }
    return null;
}

const lastPrefetchTime = {};

function pruneQueueForQuality(
    dirPath,
    type,
    identifier,
    currentIndex,
    prefetchCount,
) {
    const minIdx = currentIndex;
    const maxIdx = currentIndex + prefetchCount;

    for (let i = transcodeQueue.length - 1; i >= 0; i--) {
        const task = transcodeQueue[i];
        if (path.dirname(task.filePath) === dirPath) {
            const taskParsed = parseSegmentPath(task.filePath);
            if (taskParsed) {
                const isMatch =
                    (type === "video" &&
                        taskParsed.type === "video" &&
                        taskParsed.height === identifier) ||
                    (type === "audio" &&
                        taskParsed.type === "audio" &&
                        taskParsed.trackId === identifier);
                if (
                    isMatch &&
                    (taskParsed.index < minIdx || taskParsed.index > maxIdx)
                ) {
                    transcodeQueue.splice(i, 1);
                    delete activeTranscodes[task.filePath];
                    if (task.reject) {
                        task.reject(new Error(`Prefetch task cancelled/pruned`));
                    }
                    console.log(
                        `[Queue] Pruned obsolete prefetch task: ${path.basename(task.filePath)}`,
                    );
                }
            }
        }
    }
}

function prefetchNextSegments(filePath) {
    const dirPath = path.dirname(filePath);
    const parsed = parseSegmentPath(filePath);
    if (!parsed) return;

    // Throttling: Do not recreate prefetch tasks if a request has already triggered prefetching within the last 2 seconds for this stream folder
    const now = Date.now();
    if (lastPrefetchTime[dirPath] && now - lastPrefetchTime[dirPath] < 2000) {
        return;
    }
    lastPrefetchTime[dirPath] = now;

    const metaPath = path.join(dirPath, "metadata.json");
    if (!fs.existsSync(metaPath)) return;

    try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const { qualities } = metadata;

        (async () => {
            if (parsed.type === "video") {
                // 1. Fetch the requested quality first (upcoming 1 minutes)
                const requestedPrefix = `video_${parsed.height}p`;
                const videoSegmentTime = 12;
                const prefetchCount = Math.ceil(60 / videoSegmentTime);

                pruneQueueForQuality(
                    dirPath,
                    "video",
                    parsed.height,
                    parsed.index,
                    prefetchCount,
                );

                for (let i = 1; i <= prefetchCount; i++) {
                    const nextPath = path
                        .join(
                            dirPath,
                            `${requestedPrefix}_${String(parsed.index + i).padStart(3, "0")}.ts`,
                        )
                        .replaceAll("\\", "/");
                    if (!fs.existsSync(nextPath)) {
                        try {
                            await prepareSegmentOnTheFly(nextPath, false); // Fetch sequentially
                        } catch (e) {
                            // Ignore
                        }
                    }
                }
            } else if (parsed.type === "audio") {
                const prefetchCount = Math.ceil(120 / 12);
                pruneQueueForQuality(
                    dirPath,
                    "audio",
                    parsed.trackId,
                    parsed.index,
                    prefetchCount,
                );

                const prefix = `audio_${parsed.trackId}`;
                for (let i = 1; i <= prefetchCount; i++) {
                    const nextPath = path
                        .join(
                            dirPath,
                            `${prefix}_${String(parsed.index + i).padStart(3, "0")}.ts`,
                        )
                        .replaceAll("\\", "/");
                    if (!fs.existsSync(nextPath)) {
                        try {
                            await prepareSegmentOnTheFly(nextPath, false); // Fetch sequentially
                        } catch (e) {
                            // Ignore
                        }
                    }
                }
            }
        })();
    } catch (e) {
        console.error("Error in prefetchNextSegments:", e);
    }
}

async function prepareSegmentOnTheFly(filePath, isHighPriority = true) {
    const normalizedPath = path.normalize(filePath).replaceAll("\\", "/");
    if (activeTranscodes[normalizedPath]) {
        return activeTranscodes[normalizedPath].promise;
    }

    let taskResolve, taskReject;
    const promise = new Promise((resolve, reject) => {
        taskResolve = resolve;
        taskReject = reject;
    });

    const task = {
        filePath: normalizedPath,
        promise,
        resolve: taskResolve,
        reject: taskReject,
        process: null,
        isRunning: false,
        run: async () => {
            task.isRunning = true;
            try {
                const message = `Transcoding ${path.basename(normalizedPath)} (priority: ${cachedPreferredQuality[path.basename(path.dirname(normalizedPath))]}p, currentIndex: ${currentlyProcessingChunks[path.basename(path.dirname(normalizedPath))]})`;
                console.log(message);
                axios.post("http://localhost:9090", { message }).catch(() => { });
                await performTranscode(normalizedPath, (cmd) => {
                    task.process = cmd;
                });
                taskResolve();
            } catch (err) {
                taskReject(err);
            } finally {
                task.isRunning = false;
                task.process = null;
                delete activeTranscodes[normalizedPath];
            }
        },
    };

    activeTranscodes[normalizedPath] = task;
    transcodeQueue.push(task);

    runNextInQueue();

    return promise;
}

async function performTranscode(filePath, onCmdReady) {
    const dirPath = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const metaPath = path.join(dirPath, "metadata.json");

    if (!fs.existsSync(metaPath)) {
        throw new Error(`Metadata file not found: ${metaPath}`);
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const { sourcePath, videoStreamIndex, audioTracks, qualities } = metadata;

    const isVideo = fileName.startsWith("video_");
    let streamIndex;
    let ffmpegParams = [];
    let segmentIndex;
    let segmentTime = 12;

    if (isVideo) {
        const match = fileName.match(/video_(\d+)p_(\d+)\.ts/);
        if (!match) throw new Error(`Invalid video segment filename: ${fileName}`);
        const height = parseInt(match[1]);
        segmentIndex = parseInt(match[2]);

        const qualityOpts = qualities.find((q) => q.height === height);
        if (!qualityOpts)
            throw new Error(`Quality ${height}p not found in metadata`);

        streamIndex = videoStreamIndex;

        // Dynamically probe videoCodec if missing from metadata.json
        let videoCodec = metadata.videoCodec;
        if (!videoCodec) {
            try {
                const probeResult = execSync(
                    `"${ffprobeBinaryPath}" -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${sourcePath}"`,
                    { encoding: "utf8" },
                );
                const codecMatch = probeResult.match(/codec_name=(.+)/);
                if (codecMatch) {
                    videoCodec = codecMatch[1].trim();
                    metadata.videoCodec = videoCodec;
                    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
                }
            } catch (e) {
                console.error("Failed to dynamically probe video codec:", e);
            }
        }

        // Check if this is the original quality
        const maxHeight = qualities.reduce(
            (max, q) => (q.height > max ? q.height : max),
            0,
        );
        const isOriginalQuality = height === maxHeight;

        // Stream copy if it is the original quality and the source codec is H.264
        const canStreamCopy = false; // Disabled to prevent frame repetition and stitching issues caused by non-frame-accurate seeking during copying

        if (canStreamCopy) {
            console.log(
                `[Transcode] Remuxing (copying stream) for original quality segment: ${fileName} (Codec: ${videoCodec})`,
            );
            ffmpegParams = ["-an", "-c:v", "copy"];
            if (videoCodec === "hevc" || videoCodec === "hvc1") {
                ffmpegParams.push("-tag:v:0", "hvc1", "-bsf:v", "hevc_mp4toannexb");
            }
        } else {
            const safeHeight = Math.round(height / 2) * 2;
            const preset = "ultrafast";
            ffmpegParams = [
                "-an",
                "-c:v",
                "libx264",
                "-vf",
                `scale=-2:${safeHeight}`,
                "-b:v",
                qualityOpts.bitrate,
                "-maxrate",
                qualityOpts.bitrate,
                "-bufsize",
                `${parseInt(qualityOpts.bitrate) * 2}k`,
                "-profile:v",
                "main",
                "-pix_fmt",
                "yuv420p",
                "-crf",
                "23",
                "-preset",
                preset,
                "-force_key_frames",
                `expr:gte(t,n_forced*${segmentTime})`,
                "-sc_threshold",
                "0",
            ];
        }
    } else {
        const match = fileName.match(/audio_(\d+)_(\d+)\.ts/);
        if (!match) throw new Error(`Invalid audio segment filename: ${fileName}`);
        const audioTrackId = parseInt(match[1]);
        segmentIndex = parseInt(match[2]);

        const track = audioTracks.find((t) => t.id === `audio_${audioTrackId}`);
        if (!track)
            throw new Error(
                `Audio track index ${audioTrackId} not found in metadata`,
            );

        streamIndex = track.index;
        ffmpegParams = ["-vn", "-c:a", "aac", "-ac", "2", "-ar", "44100"];
    }

    const startTime = segmentIndex * segmentTime;
    const tempPath = filePath + ".tmp";

    await new Promise((resolve, reject) => {
        const cmd = ffmpeg(sourcePath);
        if (onCmdReady) onCmdReady(cmd);
        // Optimize input seeking
        cmd.inputOptions(["-ss", startTime.toString(), "-fflags", "+genpts"]);
        cmd.outputOptions([
            "-map",
            `0:${streamIndex}`,
            "-t",
            segmentTime.toString(),
            ...ffmpegParams,
            "-output_ts_offset",
            startTime.toString(),
            "-hls_time",
            segmentTime.toString(),
            "-hls_list_size",
            "0",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-max_muxing_queue_size",
            "2048",
            "-f",
            "mpegts",
        ]);
        cmd.output(tempPath);

        cmd.on("end", (stdout, stderr) => {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.renameSync(tempPath, filePath);
                    resolve();
                } else {
                    console.error(
                        `❌ Transcode finished but output file ${tempPath} was not created.\nStderr:\n${stderr}`,
                    );
                    reject(
                        new Error(
                            `Transcode finished but output file ${tempPath} was not created.`,
                        ),
                    );
                }
            } catch (err) {
                reject(err);
            }
        });
        cmd.on("error", (err, stdout, stderr) => {
            if (fs.existsSync(tempPath)) {
                try {
                    fs.unlinkSync(tempPath);
                } catch (_) { }
            }
            reject(err);
        });
        cmd.run();
    });
}

function serveVideoFileWithRange(req, res, filePath, contentType = "video/mp4") {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, {
            "Content-Type": "text/plain",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
        });
        return res.end("File not found");
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const MAX_CHUNK_SIZE = 1024 * 1024; // 1 MB per chunk: low latency, zero backpressure stalls

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : start + MAX_CHUNK_SIZE - 1;

        if (isNaN(start) || start >= fileSize) {
            res.writeHead(416, {
                "Content-Range": `bytes */${fileSize}`,
                "Access-Control-Allow-Origin": "*",
                "Connection": "keep-alive"
            });
            return res.end();
        }

        if (end >= fileSize) {
            end = fileSize - 1;
        }
        if (end - start + 1 > MAX_CHUNK_SIZE) {
            end = start + MAX_CHUNK_SIZE - 1;
        }

        const chunkSize = end - start + 1;
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(filePath, "r");
        try {
            fs.readSync(fd, buffer, 0, chunkSize, start);
        } finally {
            fs.closeSync(fd);
        }

        res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive",
            "Cache-Control": "public, max-age=3600"
        });
        return res.end(buffer);
    } else {
        if (fileSize <= MAX_CHUNK_SIZE) {
            const buffer = fs.readFileSync(filePath);
            res.writeHead(200, {
                "Content-Length": fileSize,
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
                "Connection": "keep-alive"
            });
            return res.end(buffer);
        }

        const chunkSize = MAX_CHUNK_SIZE;
        const buffer = Buffer.alloc(chunkSize);
        const fd = fs.openSync(filePath, "r");
        try {
            fs.readSync(fd, buffer, 0, chunkSize, 0);
        } finally {
            fs.closeSync(fd);
        }
        res.writeHead(206, {
            "Content-Range": `bytes 0-${chunkSize - 1}/${fileSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunkSize,
            "Content-Type": contentType,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive"
        });
        return res.end(buffer);
    }
}

async function handleCctvFeed(req, res, streamPath) {
    const cctvHlsDir = path.join(__dirname, "../onvif-backend/public/hls");
    const localFile = path.join(cctvHlsDir, streamPath);
    const isM3u8 = streamPath.endsWith(".m3u8");
    const contentType = isM3u8 ? "application/vnd.apple.mpegurl" : "video/mp2t";

    if (fs.existsSync(localFile)) {
        try {
            const buffer = fs.readFileSync(localFile);
            if (buffer.length > 0) {
                const headers = {
                    "Content-Type": contentType,
                    "Content-Length": buffer.length,
                    "Access-Control-Allow-Origin": "*",
                    "Connection": "keep-alive",
                    "Cache-Control": isM3u8 ? "no-cache, no-store, must-revalidate" : "public, max-age=3600"
                };
                if (isM3u8) {
                    headers["Pragma"] = "no-cache";
                    headers["Expires"] = "0";
                }
                res.writeHead(200, headers);
                return res.end(buffer);
            }
        } catch (readErr) {
            console.warn(`[CCTV Disk Read Error] ${streamPath}:`, readErr.message);
        }
    }

    try {
        const response = await axios.get(
            `http://localhost:5001/hls/${streamPath}`,
            { responseType: "arraybuffer", timeout: 5000 }
        );
        const buf = Buffer.from(response.data);
        res.writeHead(response.status || 200, {
            "Content-Type": response.headers["content-type"] || contentType,
            "Content-Length": buf.length,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive",
            "Cache-Control": isM3u8 ? "no-cache, no-store, must-revalidate" : "public, max-age=3600"
        });
        return res.end(buf);
    } catch (err) {
        const msg = "CCTV feed segment unavailable";
        res.writeHead(err.response?.status || 404, {
            "Content-Type": "text/plain",
            "Content-Length": Buffer.byteLength(msg),
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
        });
        return res.end(msg);
    }
}

async function handleStreamRecordingCommon(req, res, recSubPath) {
    const filename = path.basename(decodeURIComponent(recSubPath));
    const recordingsDir = path.join(__dirname, "../onvif-backend/recordings");
    const filePath = path.join(recordingsDir, filename);

    if (fs.existsSync(filePath)) {
        if (filename.endsWith(".m3u8") || filename.endsWith(".ts")) {
            const buffer = fs.readFileSync(filePath);
            const contentType = filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
            res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Length": buffer.length,
                "Access-Control-Allow-Origin": "*",
                "Connection": "keep-alive"
            });
            return res.end(buffer);
        }
        return serveVideoFileWithRange(req, res, filePath, "video/mp4");
    }

    try {
        const response = await axios.get(
            `http://localhost:5001/api/recordings/stream/${recSubPath}`,
            {
                responseType: "arraybuffer",
                headers: req.headers.range ? { range: req.headers.range } : {},
                params: req.query,
                timeout: 10000,
            }
        );
        const buf = Buffer.from(response.data);
        const headers = {
            "Content-Type": response.headers["content-type"] || "video/mp4",
            "Content-Length": buf.length,
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive"
        };
        if (response.headers["content-range"]) {
            headers["Content-Range"] = response.headers["content-range"];
        }
        if (response.headers["content-disposition"]) {
            headers["Content-Disposition"] = response.headers["content-disposition"];
        }
        res.writeHead(response.status || 200, headers);
        return res.end(buf);
    } catch (err) {
        const msg = "Recording file not found";
        res.writeHead(err.response?.status || 404, {
            "Content-Type": "text/plain",
            "Content-Length": Buffer.byteLength(msg),
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
        });
        return res.end(msg);
    }
}

// Middleware to set correct headers for HLS files and transcode segments on the fly
app.use("/stream", async (req, res, next) => {
    let id = req.path;
    if (id.includes("camera/")) {
        const streamPath = id.substring(id.indexOf("camera/") + 7);
        return handleCctvFeed(req, res, streamPath);
    } else if (id.includes("recordings/")) {
        const recSubPath = id.substring(id.indexOf("recordings/") + 11);
        return handleStreamRecordingCommon(req, res, recSubPath);
    } else if (id.includes("streams/")) {
        id = id.substring(id.lastIndexOf("streams/") + 8);
        id = id.substring(0, id.lastIndexOf("/"));
    }
    lastRequestTime[id] = Date.now();
    if (req.path.endsWith(".m3u8") || req.path.endsWith(".ts")) {
        const filePath = path
            .join(__dirname, decodeURIComponent(req.path))
            .replaceAll("\\", "/");
        if (filePath.endsWith(".m3u8")) {
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            if (filePath.endsWith("master.m3u8")) {
                if (req.query?.maxQuality) {
                    if (fs.existsSync(filePath)) {
                        console.log(
                            `Filtering manifest for max quality: ${req.query.maxQuality}p`,
                        );
                        return res.send(
                            filterManifest(
                                fs.readFileSync(filePath, "utf8"),
                                req.query.maxQuality,
                            ),
                        );
                    }
                }
            }
        } else if (filePath.endsWith(".ts")) {
            const parsed = parseSegmentPath(filePath);
            if (parsed && parsed.type === "video") {
                cachedPreferredQuality[id] = parsed.height || 144;
            }
            currentlyProcessingChunks[id] = parsed.index;
            res.setHeader("Content-Type", "video/mp2t");
            if (!fs.existsSync(filePath)) {
                try {
                    await prepareSegmentOnTheFly(filePath, true);
                } catch (err) {
                    console.error("Error generating segment on the fly:", err);
                    return res.status(500).send("Error generating segment");
                }
            }
        }
    }
    next();
});

// Serve the HLS video files
app.use("/stream", (req, res) => {
    if (req.path.endsWith(".m3u8") || req.path.endsWith(".ts")) {
        const filePath = path
            .join(__dirname, decodeURIComponent(req.path))
            .replaceAll("\\", "/");
        if (fs.existsSync(filePath)) {
            const contentType = filePath.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl"
                : "video/mp2t";
            const buffer = fs.readFileSync(filePath);
            res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Length": buffer.length,
                "Access-Control-Allow-Origin": "*",
                "Connection": "keep-alive"
            });
            res.end(buffer);
            if (filePath.endsWith(".ts")) {
                prefetchNextSegments(filePath);
            }
        } else res.status(404).send("File not found");
    } else {
        const videoPath = JSON.parse(
            fs.readFileSync(path.join(__dirname, "videos_index.json"), "utf8"),
        )[req.path.replaceAll("\\", "").replaceAll("/", "")];
        if (!videoPath) {
            console.error("Requested file not found in index:", req.path);
            res.status(404).send("File not found");
            return;
        }
        const ext = path.extname(videoPath).slice(1) || "mp4";
        return serveVideoFileWithRange(req, res, videoPath, `video/${ext}`);
    }
});

app.get("/", async (req, res) => {
    res.send(await si.battery());
});

app.get("/videos", (req, res) => {
    let ip = req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "local";
    let isDirectConnection = true;
    if (peerIpRegistry[ip]) {
        isDirectConnection = peerIpRegistry[ip].startsWith("192.168.");
    }
    let streamSingleQualityRemotely = false;
    let streamSingleQualityLocally = true;
    let forceStreamSingleQuality = false;
    if (fs.existsSync(path.join(__dirname, "userPreferences.json"))) {
        const userPreferences = JSON.parse(
            fs.readFileSync(path.join(__dirname, "userPreferences.json"), "utf8"),
        );
        streamSingleQualityRemotely =
            userPreferences.streamSingleQualityRemotely || false;
        streamSingleQualityLocally =
            userPreferences.streamSingleQualityLocally ?? true;
        forceStreamSingleQuality =
            userPreferences.forceStreamSingleQuality || false;
    }
    axios
        .post("http://localhost:9090", {
            message: `Device connected ${ip}: ${isDirectConnection ? "Locally" : "Remotely"}`,
        })
        .then(() => {
            setTimeout(() => {
                axios.post("http://localhost:9090", { message: "" });
            }, 5000);
        })
        .catch(() => { });
    res.statusCode = 200;
    res.contentType = "application/json";
    const response = [];
    for (const key in fileIdPathMap) {
        const filePath = fileIdPathMap[key];
        const fileName = path.basename(filePath);
        response.push({
            name: fileName,
            path: forceStreamSingleQuality
                ? key
                : `streams/${key}/master.m3u8${!req.query.forceMultiQuality && isDirectConnection && streamSingleQualityLocally ? "?maxQuality=2160" : ""}`,
            subtitle: true,
        });
    }
    response.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );

    // Append periodic recordings stored in separate variable cachedRecordings
    for (const rec of cachedRecordings) {
        response.push({
            name: rec.name,
            path: rec.path,
            coverImage: rec.alertExists ? `${globalUrl}/alerts/image/${rec.name.replace(".mp4", ".jpg")}` : undefined,
            subtitle: false,
        });
    }
    if (isCameraFeedAvailable) {
        response.unshift({
            name: "CCTV feed",
            path: "camera/stream.m3u8",
            subtitle: false,
        });
    }
    res.send(response);
});

// Recordings Endpoint - Keep recordings separate from video indices
app.get("/recordings", async (req, res) => {
    if (cachedRecordings && cachedRecordings.length > 0) {
        return res.json({
            success: true,
            count: cachedRecordings.length,
            recordings: cachedRecordings,
        });
    }
    try {
        const backendRes = await axios.get("http://localhost:5001/api/recordings");
        return res.json(backendRes.data);
    } catch (err) {
        const recordingsDir = path.join(__dirname, "../onvif-backend/recordings");
        if (fs.existsSync(recordingsDir)) {
            const files = fs
                .readdirSync(recordingsDir)
                .filter((f) => f.endsWith(".mp4"));
            const recordings = files
                .map((file) => {
                    const stats = fs.statSync(path.join(recordingsDir, file));
                    return {
                        filename: file,
                        sizeBytes: stats.size,
                        sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                        createdAt: stats.birthtime || stats.mtime,
                        modifiedAt: stats.mtime,
                        downloadUrl: `/recordings/download?id=${file}`,
                        streamUrl: `/recordings/${file}`,
                    };
                })
                .sort((a, b) => b.modifiedAt - a.modifiedAt);
            return res.json({ success: true, count: recordings.length, recordings });
        }
        res
            .status(500)
            .json({
                success: false,
                error: "Recordings unavailable: " + err.message,
            });
    }
});

const handleServerDownloadRecording = async (req, res) => {
    const filenameParam =
        req.query.id || req.query.filename || req.params.filename;
    if (!filenameParam) {
        return res
            .status(400)
            .json({ success: false, error: "id query parameter is required" });
    }
    const filename = path.basename(filenameParam);
    const recordingsDir = path.join(__dirname, "../onvif-backend/recordings");
    const filePath = path.join(recordingsDir, filename);
    if (fs.existsSync(filePath)) {
        const buffer = fs.readFileSync(filePath);
        res.writeHead(200, {
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Type": "video/mp4",
            "Content-Length": buffer.length,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive"
        });
        return res.end(buffer);
    }
    try {
        const response = await axios.get(
            `http://localhost:5001/api/recordings/download?id=${filename}`,
            { responseType: "arraybuffer", timeout: 15000 },
        );
        const buf = Buffer.from(response.data);
        res.writeHead(200, {
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Type": "video/mp4",
            "Content-Length": buf.length,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive"
        });
        return res.end(buf);
    } catch (err) {
        res.writeHead(404, { "Content-Type": "text/plain", "Connection": "keep-alive" });
        return res.end("Recording file not found");
    }
};

app.get("/recordings/download", handleServerDownloadRecording);
app.get("/recordings/download/:filename", handleServerDownloadRecording);

const handleServerStreamRecording = async (req, res) => {
    const filenameParam =
        req.params.filename || req.query.id || req.query.filename;
    if (!filenameParam) {
        return res
            .status(400)
            .json({
                success: false,
                error: "id query parameter or filename path is required",
            });
    }
    return handleStreamRecordingCommon(req, res, filenameParam);
};

app.get("/recordings/stream/:filename", handleServerStreamRecording);
app.get("/recordings/stream", handleServerStreamRecording);
app.get("/recordings/:filename", (req, res, next) => {
    if (req.params.filename === "stream" || req.params.filename === "download") return next();
    return handleServerStreamRecording(req, res);
});

// CCTV feed direct alias route
app.use("/camera", (req, res) => {
    const streamPath = req.path.replace(/^\//, "");
    return handleCctvFeed(req, res, streamPath);
});

// Alert History & Alert Image Endpoints
app.get("/alerts", async (req, res) => {
    try {
        const backendRes = await axios.get("http://localhost:5001/api/alerts");
        return res.json(backendRes.data);
    } catch (err) {
        res
            .status(500)
            .json({ success: false, error: "Alerts unavailable: " + err.message });
    }
});

const handleServerDownloadAlertImage = async (req, res) => {
    const filenameParam =
        req.query.id || req.query.filename || req.params.filename;
    if (!filenameParam) {
        return res
            .status(400)
            .json({ success: false, error: "id or filename parameter is required" });
    }
    const filename = path.basename(filenameParam);
    const alertsDir = path.join(__dirname, "../onvif-backend/human_detection_alerts");
    const localAlertPath = path.join(alertsDir, filename);
    if (fs.existsSync(localAlertPath)) {
        const buffer = fs.readFileSync(localAlertPath);
        res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": buffer.length,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive",
            "Cache-Control": "public, max-age=86400"
        });
        return res.end(buffer);
    }
    try {
        const response = await axios.get(
            `http://localhost:5001/api/alerts/download?id=${filename}`,
            { responseType: "arraybuffer", timeout: 10000 },
        );
        const buf = Buffer.from(response.data);
        res.writeHead(200, {
            "Content-Type": response.headers["content-type"] || "image/jpeg",
            "Content-Length": buf.length,
            "Access-Control-Allow-Origin": "*",
            "Connection": "keep-alive",
            "Cache-Control": "public, max-age=86400"
        });
        return res.end(buf);
    } catch (err) {
        res.writeHead(404, { "Content-Type": "text/plain", "Connection": "keep-alive" });
        return res.end("Alert image not found");
    }
};

app.get("/alerts/image/:filename", handleServerDownloadAlertImage);
app.get("/alerts/image", handleServerDownloadAlertImage);
app.get("/alerts/download", handleServerDownloadAlertImage);
app.get("/alerts/download/:filename", handleServerDownloadAlertImage);

app.get("/stop-processing", (req, res) => {
    if (fs.existsSync(`${__dirname}/isProcessing.txt`)) {
        const data = fs
            .readFileSync(`${__dirname}/isProcessing.txt`, "utf8")
            .split("\n");
        const id = data[0];
        fs.writeFileSync(`${__dirname}/stop_processing.txt`, "yes");
        setTimeout(() => {
            deleteFolderRecursive(path.join(__dirname, "streams", id));
        }, 5000);
    }
    res.json({ success: true });
});

app.get("/progress", (req, res) => {
    if (fs.existsSync(`${__dirname}/isProcessing.txt`)) {
        const response = {};
        const data = fs
            .readFileSync(`${__dirname}/isProcessing.txt`, "utf8")
            .split("\n");
        response.status = "Processing";
        response.id = data[0];
        response.path = JSON.parse(
            fs.readFileSync(`${__dirname}/videos_index.json`),
        )[data[0]];
        response.name = response.path.substring(
            response.path.lastIndexOf("\\") + 1,
        );
        const qualities = [];
        for (let i = 1; i < data.length; i++) {
            if (data[i].trim() === "") continue;
            qualities.push({
                quality: data[i].split(" ")[0],
                progress: data[i].substring(
                    data[i].indexOf("(") + 1,
                    data[i].indexOf("%"),
                ),
            });
        }
        response.qualities = qualities;
        res.json(response);
    } else {
        res.json({ status: "Idle" });
    }
});

app.get(`/download`, (req, res) => {
    let filePath = decodeURIComponent(req.query.id);
    if (filePath.includes("recordings/")) {
        return handleServerDownloadRecording(req, res);
    }
    if (filePath.includes("streams/"))
        filePath = filePath.substring(filePath.indexOf("streams/") + 8);
    if (filePath.includes("/master.m3u8"))
        filePath = filePath.substring(0, filePath.lastIndexOf("/"));
    filePath = filePath.replaceAll("\\", "").replaceAll("/", "");
    filePath = fileIdPathMap[filePath];
    res.download(filePath);
});

app.get(`/download/recordings/:filename`, (req, res) => {
    return handleServerDownloadRecording(req, res);
});

app.get("/subtitles", (req, res) => {
    let filePath = decodeURIComponent(req.query.id);
    if (filePath.includes("streams/"))
        filePath = filePath.substring(filePath.indexOf("streams/") + 8);
    if (filePath.includes("/"))
        filePath = filePath.substring(0, filePath.lastIndexOf("/"));
    exec(
        `cd ${__dirname} && ${nodePath} extract_subtitles.js --id=${filePath}`,
        (error, stdout, stderr) => {
            if (
                !fs.existsSync(path.join(__dirname, "subtitles", `${filePath}.srt`))
            ) {
                return res.status(404).send("File not found");
            }
            return res.download(path.join(__dirname, "subtitles", `${filePath}.srt`));
        },
    );
});

app.get("/profile-image", (req, res) => {
    res.download(`${__dirname}\\profile_image.jpg`.replaceAll("\\", "/"));
});
app.post("/profile-image", (req, res) => {
    try {
        const { path } = req.body;
        const data = fs.readFileSync(path);
        fs.writeFileSync(`${__dirname}\\profile_image.jpg`, data);
        res.json({
            status: "Uploaded",
            message: `Access your file at ${__dirname}\\profile_image.jpg`,
        });
    } catch (exception) {
        res.statusCode = 500;
        res.json({ error: exception.toString() });
    }
});

app.post("/watch-details", (req, res) => {
    const { body } = req;
    if (!body.firebaseUid) {
        res.statusCode = 400;
        res.contentType = "application/json";
        res.send({
            status: "bad request",
            error: "Firebase Uid not defined",
        });
        return;
    }
    if (!body.videoId) {
        res.statusCode = 400;
        res.contentType = "application/json";
        res.send({
            status: "bad request",
            error: "Video Id not defined",
        });
        return;
    }
    if (!body.dataToPut) {
        res.statusCode = 400;
        res.contentType = "application/json";
        res.send({
            status: "bad request",
            error: "No data defined to put",
        });
        return;
    }
    if (!fs.existsSync(__dirname + "/user_watch_data")) {
        fs.mkdirSync(__dirname + "/user_watch_data");
    }
    if (!fs.existsSync(path.join(__dirname, 'user_watch_data', body.firebaseUid))) {
        fs.mkdirSync(path.join(__dirname, 'user_watch_data', body.firebaseUid))
    }
    const videoId = body.videoId
        .replaceAll("streams/", "")
        .replaceAll("master.m3u8", "")
        .replaceAll("/", "")
        .split("?")[0];
    const fileName = videoId + ".json";
    if (videoId.includes(" ") || videoId.includes(".") || videoId.includes("-") || videoId.includes("_")) {
        return res.json({ status: "successful" });
    }
    const rawData = body.dataToPut.split('\t');
    const data = {
        position: Number(rawData[0]),
        duration: Number(rawData[1]),
        audioTrack: Number(rawData[2] || 0)
    }
    if (data.position === 0) {
        if (fs.existsSync(path.join(__dirname, 'user_watch_data', body.firebaseUid, fileName))) {
            fs.unlinkSync(path.join(__dirname, 'user_watch_data', body.firebaseUid, fileName))
        }
        return res.json({ status: 'successful' })
    }
    fs.writeFileSync(path.join(__dirname, 'user_watch_data', body.firebaseUid, fileName), JSON.stringify(data, null, 4))
    res.statusCode = 200;
    res.send({ status: 'successful' })
});

app.get("/watch-details", (req, res) => {
    const body = req.query;
    if (!body.firebaseUid) {
        res.statusCode = 400;
        res.contentType = "application/json";
        res.send({
            status: "bad request",
            error: "Firebase Uid not defined",
        });
        return;
    }
    if (!body.videoId) {
        res.statusCode = 400;
        res.contentType = "application/json";
        res.send({
            status: "bad request",
            error: "Video Id not defined",
        });
        return;
    }
    const fileName = body.videoId
        .replaceAll("streams/", "")
        .replaceAll("master.m3u8", "")
        .replaceAll("/", "")
        .split("?")[0] + ".json";

    if (fs.existsSync(path.join(__dirname, "user_watch_data", body.firebaseUid, fileName))) {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, "user_watch_data", body.firebaseUid, fileName)))
        const finalData = `${data.position}\t${data.duration}\t${data.audioTrack}`
        res.json({ status: "successful", data: finalData });
    } else {
        res.json({ status: "successful", data: "0\t1\t0" })
    }
});

app.get("/device-name", (req, res) => {
    res.json({
        name: os.hostname().split(".")[0],
        url: globalUrl,
        dhtKey: serverPublicKey,
        p2p: true
    });
});

app.post("/stop", async (req, res) => {
    res.send("ok");
    deleteChunkedFiles();
    try {
        for (const [key, { socket }] of activePeers.entries()) {
            socket.destroy();
        }
        await dhtServer.close();
        await dht.destroy();
        httpServer.close();
    } catch (e) { }
    exec(`cd ${__dirname} && tailscale down`, (error, stdout, stderr) => {
        process.exit(0);
    });
});

function printBanner() {
    const line = "═".repeat(74);
    console.log("\n" + line);
    console.log("  🚀 P2P HOLE-PUNCHED VIDEO STREAMING SERVER IS ONLINE (HYPERDHT)");
    console.log(line);
    console.log("  🔒 Protocol:        HyperDHT (Noise Protocol + UDP Hole-Punching)");
    console.log("  🌍 Traversal:       Works across global NATs, firewalls & CGNAT");
    console.log("  🔑 Global DHT Key:  " + serverPublicKey);
    console.log(`  💻 Local PC:        http://localhost:${PORT}`);
    if (localIpAddress && localIpAddress !== "no address" && localIpAddress !== "127.0.0.1") {
        console.log(`  📶 Local Wi-Fi:     http://${localIpAddress}:${PORT}`);
    }
    if (globalUrl && globalUrl !== `http://${localIpAddress}:${PORT}`) {
        console.log(`  🌐 Global URL:      ${globalUrl}`);
    }
    console.log(line);
    console.log("  📡 HOW CLIENTS CONNECT FROM ANYWHERE IN THE WORLD:");
    console.log("");
    console.log("  1. Browse & Stream in any PC/Mac browser or video player (Proxy bridge):");
    console.log(`     node client.js ${serverPublicKey} --proxy 8080`);
    console.log("     Then open http://localhost:8080 in Chrome, Safari, VLC, etc.");
    console.log("");
    console.log("  2. Direct CLI Request / Video Index:");
    console.log(`     node client.js ${serverPublicKey} /videos`);
    console.log("");
    console.log("  3. Measure P2P Roundtrip Latency:");
    console.log(`     node client.js ${serverPublicKey} --ping`);
    console.log("");
    console.log("  4. Mobile / Native Apps (via HyperDHT client):");
    console.log(`     Connect directly to DHT Key: ${serverPublicKey}`);
    console.log(line + "\n");
}

async function start() {
    try {
        // 1. Listen on HyperDHT network for global P2P hole-punching
        await dhtServer.listen(keyPair);

        // 2. Listen on local port
        httpServer.listen(PORT, "0.0.0.0", async () => {
            axios
                .get("http://localhost:5001")
                .then((res) => {
                    isCameraFeedAvailable = true;
                })
                .catch((e) => { });
            if (fs.existsSync(path.join(__dirname, "isProcessing.txt")))
                fs.unlinkSync(path.join(__dirname, "isProcessing.txt"));
            localIpAddress = "no address";
            let { WiFi } = os.networkInterfaces();
            if (!WiFi) {
                WiFi = os.networkInterfaces()["Wi-Fi"] || os.networkInterfaces()["en0"];
            }
            if (WiFi == undefined) {
                console.log("please connect to WiFi");
            } else {
                for (let i = 0; i < WiFi.length; i++) {
                    if (WiFi[i].family == "IPv4") {
                        localIpAddress = WiFi[i].address;
                    }
                }
            }
            console.log("Select a video folder to stream from:");
            const folderPath = getFolderPathToCastVideos();
            if (folderPath) {
                console.log(`🎬 Streaming videos from folder: ${folderPath}`);
                exploreFolderForVideos(folderPath);
                console.log(`📂 Found ${Object.keys(fileIdPathMap).length} video files.`);
                fs.writeFileSync(
                    path.join(__dirname, "videos_index.json"),
                    JSON.stringify(fileIdPathMap, null, 2),
                );
                await prepareAllM3u8Files();
            }
            printBanner();
        });
    } catch (err) {
        console.error("Failed to start hole-punched streaming server:", err);
        process.exit(1);
    }
}

async function shutdown() {
    console.log("\n[Shutdown] Closing hole-punched server gracefully...");
    try {
        for (const [key, { socket }] of activePeers.entries()) {
            socket.destroy();
        }
        await dhtServer.close();
        await dht.destroy();
        httpServer.close();
        console.log("[Shutdown] Server stopped.");
        process.exit(0);
    } catch (err) {
        console.error("[Shutdown Error]", err);
        process.exit(1);
    }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();
