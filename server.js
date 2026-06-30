const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const si = require('systeminformation');
const crypto = require('crypto');
const { exec } = require('child_process');
const { execSync } = require('child_process');
const e = require('express');
const http = require('http');
const { default: axios } = require('axios');
const httpPort = 6969;
let serverIpAddressResponse;
let lastRequestTime = {};
const deletionInterval = 5 * 60 * 1000;

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

deleteFolderRecursive(path.join(__dirname, "streams"));

const deleteChunkedFiles = () => {
    if (!fs.existsSync(path.join(__dirname, 'streams'))) return;
    const files = fs.readdirSync(path.join(__dirname, 'streams'));
    files.forEach(f => {
        if ((lastRequestTime[f] || 0) + deletionInterval > Date.now()) {
            return;
        }
        const chunks = fs.readdirSync(path.join(__dirname, 'streams', f)).filter(c => c.endsWith('.ts'));
        if (chunks.length > 0) console.log(`Deleting chunks for video: ${f}`);
        for (let i = 0; i < chunks.length; i++) {
            fs.unlinkSync(path.join(__dirname, 'streams', f, chunks[i]));
        }
    });
}

setInterval(deleteChunkedFiles, deletionInterval);
deleteChunkedFiles();

const ffmpeg = require('fluent-ffmpeg');
let ffmpegBinaryPath = 'ffmpeg';
let ffprobeBinaryPath = 'ffprobe';
if (fs.existsSync(path.join(__dirname, 'ffmpeg/bin/ffmpeg.exe'))) {
    ffmpegBinaryPath = path.join(__dirname, 'ffmpeg/bin/ffmpeg.exe');
    ffprobeBinaryPath = path.join(__dirname, 'ffmpeg/bin/ffprobe.exe');
} else if (fs.existsSync(path.join(__dirname, '../ffmpeg/bin/ffmpeg.exe'))) {
    ffmpegBinaryPath = path.join(__dirname, '../ffmpeg/bin/ffmpeg.exe');
    ffprobeBinaryPath = path.join(__dirname, '../ffmpeg/bin/ffprobe.exe');
} else if (fs.existsSync(path.join(__dirname, 'ffmpeg_path.txt'))) {
    ffmpegBinaryPath = fs.readFileSync(path.join(__dirname, 'ffmpeg_path.txt'), 'utf8').trim().replace(/"/g, '');
    ffprobeBinaryPath = ffmpegBinaryPath.replace('ffmpeg', 'ffprobe');
} else if (fs.existsSync(path.join(__dirname, '../ffmpeg_path.txt'))) {
    ffmpegBinaryPath = fs.readFileSync(path.join(__dirname, '../ffmpeg_path.txt'), 'utf8').trim().replace(/"/g, '');
    ffprobeBinaryPath = ffmpegBinaryPath.replace('ffmpeg', 'ffprobe');
}
ffmpeg.setFfmpegPath(ffmpegBinaryPath);
ffmpeg.setFfprobePath(ffprobeBinaryPath);

const ALL_VIDEO_QUALITIES = [
    { height: 144, bitrate: '200k' },
    { height: 240, bitrate: '400k' },
    { height: 360, bitrate: '800k' },
    { height: 480, bitrate: '1200k' },
    { height: 720, bitrate: '2500k' },
    { height: 1080, bitrate: '5000k' },
    { height: 1440, bitrate: '8000k' },
    { height: 2160, bitrate: '15000k' }
];

let globalUrl = "";
let localIpAddress = "no address";

const fileIdPathMap = {};

const nodePath = fs.existsSync(path.join(__dirname, '../node_path.txt')) ? fs.readFileSync(path.join(__dirname, '../node_path.txt'), 'utf8') : 'node';

const app = express();
const PORT = 9000;

app.use(cors());

http.createServer((req, res) => {
    if (req.url == "/server-ip-address-for-streamvilla") {
        if (globalUrl !== "") {
            res.end(globalUrl);
        }
        serverIpAddressResponse = res;
    } else {
        res.end("no");
    }
}).listen(httpPort);

const files = fs.existsSync(path.join(__dirname, 'streams')) ? fs.readdirSync(path.join(__dirname, 'streams')) : [];
files.forEach(f => {
    if (!fs.existsSync(path.join(__dirname, 'streams', f, 'createdAt.txt'))) {
        deleteFolderRecursive(path.join(__dirname, 'streams', f));
        console.log(`🗑️  Deleted incomplete stream directory: ${f}`);
    }
});

const getFolderPathToCastVideos = () => {
    if (fs.existsSync(path.join(__dirname, 'path.txt'))) {
        return fs.readFileSync(path.join(__dirname, 'path.txt'), 'utf8').replaceAll('\\', '/');
    }
    // This single-line command prevents "MissingEndCurlyBrace" errors
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select Video Folder'; if($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"`;

    try {
        const result = execSync(cmd, { encoding: 'utf8' }).trim();
        return result?.replaceAll('\\', '/');
    } catch (err) {
        console.error("User closed the dialog or an error occurred.");
        return null;
    }
}

deleteFolderRecursive(path.join(__dirname, 'subtitles'));

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
            if (ext === '.mp4' || ext === '.mkv') {
                const fileId = crypto.createHash('md5').update(fullPath).digest('hex');
                fileIdPathMap[fileId] = fullPath;
            }
        }
    }
}

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function filterManifest(originalM3u8, maxQuality) {
    const lines = originalM3u8.split('\n');
    let output = [];
    let finalLine = '';
    let keepNextUri = true;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-STREAM-INF')) {
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
        } else if (line.startsWith('#')) {
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

    return output.join('\n');
}

async function prepareAllM3u8Files() {
    console.log("⚙️  Preparing HLS m3u8 playlist files...");
    const keys = Object.keys(fileIdPathMap);
    for (const id of keys) {
        const videoPath = fileIdPathMap[id];
        const streamDir = path.join(__dirname, 'streams', id);
        const masterPlaylistPath = path.join(streamDir, 'master.m3u8');

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

            const vStream = metadata.streams.find(s => s.codec_type === 'video');
            const aStreams = metadata.streams.filter(s => s.codec_type === 'audio');
            if (!vStream) {
                throw new Error("No video stream found");
            }

            const validQualities = ALL_VIDEO_QUALITIES.filter(q => q.height <= vStream.height);
            if (validQualities.length === 0 || validQualities[validQualities.length - 1].height !== vStream.height) {
                validQualities.push({ height: vStream.height, bitrate: '2000k' });
            }

            const audioTracks = aStreams.map((s, i) => ({
                index: s.index,
                id: `audio_${i}`,
                lang: s.tags?.language || 'und',
                name: s.tags?.title || s.tags?.language || `Track ${i + 1}`
            }));

            // Save metadata for on-the-fly segment generation
            const metaJson = {
                sourcePath: videoPath,
                duration: duration,
                videoStreamIndex: vStream.index,
                videoCodec: vStream.codec_name,
                audioTracks: audioTracks,
                qualities: validQualities
            };
            fs.writeFileSync(path.join(streamDir, 'metadata.json'), JSON.stringify(metaJson, null, 2));

            // Write master.m3u8
            let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
            audioTracks.forEach((t, i) => {
                masterContent += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",LANGUAGE="${t.lang}",NAME="${t.name}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${t.id}.m3u8"\n`;
            });

            [...validQualities].sort((a, b) => a.height - b.height).forEach(q => {
                masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${(parseInt(q.bitrate) + 192) * 1000},RESOLUTION=1280x${q.height},AUDIO="stereo"\nvideo_${q.height}p.m3u8\n`;
            });
            fs.writeFileSync(masterPlaylistPath, masterContent);

            // Write audio playlists
            const segmentTime = 12;
            const segmentCount = Math.ceil(duration / segmentTime);

            audioTracks.forEach(t => {
                let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n`;
                for (let i = 0; i < segmentCount; i++) {
                    let curDur = segmentTime;
                    if (i === segmentCount - 1) {
                        curDur = duration - i * segmentTime;
                    }
                    playlist += `#EXTINF:${curDur.toFixed(6)},\n${t.id}_${String(i).padStart(3, '0')}.ts\n`;
                }
                playlist += `#EXT-X-ENDLIST\n`;
                fs.writeFileSync(path.join(streamDir, `${t.id}.m3u8`), playlist);
            });

            // Write video playlists
            validQualities.forEach(q => {
                const videoSegmentTime = q.height >= 1080 ? 8 : 12;
                const videoSegmentCount = Math.ceil(duration / videoSegmentTime);
                let playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${videoSegmentTime}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n`;
                for (let i = 0; i < videoSegmentCount; i++) {
                    let curDur = videoSegmentTime;
                    if (i === videoSegmentCount - 1) {
                        curDur = duration - i * videoSegmentTime;
                    }
                    playlist += `#EXTINF:${curDur.toFixed(6)},\nvideo_${q.height}p_${String(i).padStart(3, '0')}.ts\n`;
                }
                playlist += `#EXT-X-ENDLIST\n`;
                fs.writeFileSync(path.join(streamDir, `video_${q.height}p.m3u8`), playlist);
            });

            fs.writeFileSync(path.join(streamDir, 'createdAt.txt'), `${Date.now()}`);
            console.log(`✅ Prepared manifests for: ${path.basename(videoPath)}`);
        } catch (err) {
            console.error(`❌ Failed to prepare playlists for: ${path.basename(videoPath)}`, err);
        }
    }
}

const activeTranscodes = {};
const transcodeQueue = [];
let activeTranscodeCount = 0;
const MAX_CONCURRENT = Math.max(1, os.cpus().length - 1);

function runNextInQueue() {
    if (activeTranscodeCount >= MAX_CONCURRENT) return;
    if (transcodeQueue.length === 0) return;

    // Prioritize the requested segment over prefetch jobs:
    // Sort queue so high priority (priority = true) comes first
    transcodeQueue.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));

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
        return { type: 'video', index: parseInt(match[2]), height: parseInt(match[1]) };
    }
    match = fileName.match(/audio_(\d+)_(\d+)\.ts/);
    if (match) {
        return { type: 'audio', index: parseInt(match[2]), trackId: parseInt(match[1]) };
    }
    return null;
}

const lastPrefetchTime = {};

function pruneQueueForQuality(dirPath, type, identifier, currentIndex, prefetchCount) {
    const minIdx = currentIndex;
    const maxIdx = currentIndex + prefetchCount;

    for (let i = transcodeQueue.length - 1; i >= 0; i--) {
        const task = transcodeQueue[i];
        if (!task.priority && path.dirname(task.filePath) === dirPath) {
            const taskParsed = parseSegmentPath(task.filePath);
            if (taskParsed) {
                const isMatch = (type === 'video' && taskParsed.type === 'video' && taskParsed.height === identifier) ||
                    (type === 'audio' && taskParsed.type === 'audio' && taskParsed.trackId === identifier);
                if (isMatch && (taskParsed.index < minIdx || taskParsed.index > maxIdx)) {
                    transcodeQueue.splice(i, 1);
                    delete activeTranscodes[task.filePath];
                    if (task.reject) {
                        task.reject(new Error(`Prefetch task cancelled/pruned`));
                    }
                    console.log(`[Queue] Pruned obsolete prefetch task: ${path.basename(task.filePath)}`);
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
    if (lastPrefetchTime[dirPath] && (now - lastPrefetchTime[dirPath]) < 2000) {
        return;
    }
    lastPrefetchTime[dirPath] = now;

    const metaPath = path.join(dirPath, 'metadata.json');
    if (!fs.existsSync(metaPath)) return;

    try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const { qualities } = metadata;

        (async () => {
            if (parsed.type === 'video') {
                // 1. Fetch the requested quality first (upcoming 2 minutes)
                const requestedPrefix = `video_${parsed.height}p`;
                const videoSegmentTime = parsed.height >= 1080 ? 8 : 12;
                const prefetchCount = Math.ceil(120 / videoSegmentTime);

                pruneQueueForQuality(dirPath, 'video', parsed.height, parsed.index, prefetchCount);

                for (let i = 1; i <= prefetchCount; i++) {
                    const nextPath = path.join(dirPath, `${requestedPrefix}_${String(parsed.index + i).padStart(3, '0')}.ts`).replaceAll('\\', '/');
                    if (!fs.existsSync(nextPath)) {
                        try {
                            await prepareSegmentOnTheFly(nextPath, false); // Fetch sequentially
                        } catch (e) {
                            // Ignore
                        }
                    }
                }
            } else if (parsed.type === 'audio') {
                const prefetchCount = Math.ceil(120 / 12);
                pruneQueueForQuality(dirPath, 'audio', parsed.trackId, parsed.index, prefetchCount);

                const prefix = `audio_${parsed.trackId}`;
                for (let i = 1; i <= prefetchCount; i++) {
                    const nextPath = path.join(dirPath, `${prefix}_${String(parsed.index + i).padStart(3, '0')}.ts`).replaceAll('\\', '/');
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
    const normalizedPath = path.normalize(filePath).replaceAll('\\', '/');
    if (activeTranscodes[normalizedPath]) {
        const active = activeTranscodes[normalizedPath];
        if (isHighPriority && !active.priority) {
            active.priority = true;
            console.log(`[Queue] Upgraded priority to high for: ${path.basename(normalizedPath)}`);
        }
        return active.promise;
    }

    let taskResolve, taskReject;
    const promise = new Promise((resolve, reject) => {
        taskResolve = resolve;
        taskReject = reject;
    });

    const task = {
        filePath: normalizedPath,
        priority: isHighPriority,
        promise,
        resolve: taskResolve,
        reject: taskReject,
        run: async () => {
            try {
                await performTranscode(normalizedPath);
                taskResolve();
            } catch (err) {
                taskReject(err);
            } finally {
                delete activeTranscodes[normalizedPath];
            }
        }
    };

    activeTranscodes[normalizedPath] = task;
    transcodeQueue.push(task);

    runNextInQueue();

    return promise;
}

async function performTranscode(filePath) {
    const dirPath = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const metaPath = path.join(dirPath, 'metadata.json');

    if (!fs.existsSync(metaPath)) {
        throw new Error(`Metadata file not found: ${metaPath}`);
    }

    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const { sourcePath, videoStreamIndex, audioTracks, qualities } = metadata;

    const isVideo = fileName.startsWith('video_');
    let streamIndex;
    let ffmpegParams = [];
    let segmentIndex;
    let segmentTime = 12;

    if (isVideo) {
        const match = fileName.match(/video_(\d+)p_(\d+)\.ts/);
        if (!match) throw new Error(`Invalid video segment filename: ${fileName}`);
        const height = parseInt(match[1]);
        segmentIndex = parseInt(match[2]);

        if (height >= 1080) {
            segmentTime = 8;
        }

        const qualityOpts = qualities.find(q => q.height === height);
        if (!qualityOpts) throw new Error(`Quality ${height}p not found in metadata`);

        streamIndex = videoStreamIndex;

        // Dynamically probe videoCodec if missing from metadata.json
        let videoCodec = metadata.videoCodec;
        if (!videoCodec) {
            try {
                const probeResult = execSync(`"${ffprobeBinaryPath}" -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "${sourcePath}"`, { encoding: 'utf8' });
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
        const maxHeight = qualities.reduce((max, q) => q.height > max ? q.height : max, 0);
        const isOriginalQuality = (height === maxHeight);

        // Stream copy if it is the original quality and the source codec is H.264
        const canStreamCopy = false; // Disabled to prevent frame repetition and stitching issues caused by non-frame-accurate seeking during copying

        if (canStreamCopy) {
            console.log(`[Transcode] Remuxing (copying stream) for original quality segment: ${fileName} (Codec: ${videoCodec})`);
            ffmpegParams = [
                '-an', '-c:v', 'copy'
            ];
            if (videoCodec === 'hevc' || videoCodec === 'hvc1') {
                ffmpegParams.push('-tag:v:0', 'hvc1', '-bsf:v', 'hevc_mp4toannexb');
            }
        } else {
            const safeHeight = Math.round(height / 2) * 2;
            const preset = 'ultrafast';
            ffmpegParams = [
                '-an', '-c:v', 'libx264', '-vf', `scale=-2:${safeHeight}`,
                '-b:v', qualityOpts.bitrate, '-maxrate', qualityOpts.bitrate, '-bufsize', `${parseInt(qualityOpts.bitrate) * 2}k`,
                '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', preset,
                '-force_key_frames', `expr:gte(t,n_forced*${segmentTime})`, '-sc_threshold', '0'
            ];
        }
    } else {
        const match = fileName.match(/audio_(\d+)_(\d+)\.ts/);
        if (!match) throw new Error(`Invalid audio segment filename: ${fileName}`);
        const audioTrackId = parseInt(match[1]);
        segmentIndex = parseInt(match[2]);

        const track = audioTracks.find(t => t.id === `audio_${audioTrackId}`);
        if (!track) throw new Error(`Audio track index ${audioTrackId} not found in metadata`);

        streamIndex = track.index;
        ffmpegParams = ['-vn', '-c:a', 'aac', '-ac', '2', '-ar', '44100'];
    }

    const startTime = segmentIndex * segmentTime;
    const tempPath = filePath + '.tmp';

    await new Promise((resolve, reject) => {
        const cmd = ffmpeg(sourcePath);
        // Optimize input seeking
        cmd.inputOptions([
            '-ss', startTime.toString(),
            '-fflags', '+genpts'
        ]);
        cmd.outputOptions([
            '-map', `0:${streamIndex}`,
            '-t', segmentTime.toString(),
            ...ffmpegParams,
            '-output_ts_offset', startTime.toString(),
            '-hls_time', segmentTime.toString(),
            '-hls_list_size', '0',
            '-sn', '-dn', '-map_metadata', '-1',
            '-max_muxing_queue_size', '2048',
            '-f', 'mpegts'
        ]);
        cmd.output(tempPath);

        cmd.on('end', (stdout, stderr) => {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.renameSync(tempPath, filePath);
                    resolve();
                } else {
                    console.error(`❌ Transcode finished but output file ${tempPath} was not created.\nStderr:\n${stderr}`);
                    reject(new Error(`Transcode finished but output file ${tempPath} was not created.`));
                }
            } catch (err) {
                reject(err);
            }
        });
        cmd.on('error', (err, stdout, stderr) => {
            console.error(`❌ FFmpeg error: ${err.message}\nStderr:\n${stderr}`);
            if (fs.existsSync(tempPath)) {
                try { fs.unlinkSync(tempPath); } catch (_) { }
            }
            reject(err);
        });
        cmd.run();
    });
}

// Middleware to set correct headers for HLS files and transcode segments on the fly
app.use('/stream', async (req, res, next) => {
    let id = req.path;
    if (id.includes("streams/")) {
        id = id.substring(id.lastIndexOf("streams/") + 8);
        id = id.substring(0, id.lastIndexOf('/'));
    }
    lastRequestTime[id] = Date.now();
    if (req.path.endsWith('.m3u8') || req.path.endsWith('.ts')) {
        const filePath = path.join(__dirname, decodeURIComponent(req.path)).replaceAll('\\', '/');
        if (filePath.endsWith('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            if (filePath.endsWith('master.m3u8')) {
                if (req.query?.maxQuality) {
                    if (fs.existsSync(filePath)) {
                        console.log(`Filtering manifest for max quality: ${req.query.maxQuality}p`);
                        return res.send(filterManifest(fs.readFileSync(filePath, 'utf8'), req.query.maxQuality));
                    }
                }
            }
        } else if (filePath.endsWith('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
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
app.use('/stream', (req, res) => {
    if (req.path.endsWith('.m3u8') || req.path.endsWith('.ts')) {
        const filePath = path.join(__dirname, decodeURIComponent(req.path)).replaceAll('\\', '/');
        if (fs.existsSync(filePath)) {
            const contentType = filePath.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
            res.sendFile(filePath, {
                headers: {
                    'Content-Type': contentType
                }
            });
            if (filePath.endsWith('.ts')) {
                prefetchNextSegments(filePath);
            }
        }
        else res.status(404).send("File not found");
    } else {
        const videoPath = JSON.parse(fs.readFileSync(path.join(__dirname, 'videos_index.json'), 'utf8'))[req.path.replaceAll('\\', '').replaceAll('/', '')];
        if (!videoPath) {
            console.error("Requested file not found in index:", req.path);
            res.status(404).send("File not found");
            return;
        }
        const videoSize = fs.statSync(videoPath).size;
        const { range } = req.headers;
        let actualSize = videoSize / 1024 / 1024;
        // console.log(`video size = ${actualSize} MB`)
        const start =
            range == undefined
                ? 0
                : Number(range.substring("bytes=".length, range.indexOf("-")));
        let end = videoSize - 1;
        if (
            range != undefined &&
            range.includes("-") &&
            range.length > range.indexOf("-") + 1
        ) {
            end = Number(range.substring(range.indexOf("-") + 1));
        }
        actualSize = end / 1024 / 1024;
        const contentLength = end - start + 1;
        const headers = {
            "Content-Range": `bytes=${start}-${end}/${videoSize}`,
            "Accept-Ranges": "bytes",
            "Content-Length": contentLength,
            "Content-Type": `video/${videoPath.substring(
                videoPath.lastIndexOf(".") + 1
            )}`,
        };
        res.writeHead(206, headers);
        const stream = fs.createReadStream(videoPath, {
            start,
            end,
        });
        stream.pipe(res);

    }
});

app.get('/', async (req, res) => {
    res.send(await si.battery());
});

app.get("/videos", (req, res) => {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    let isDirectConnection = true;
    let streamSingleQualityRemotely = false;
    let streamSingleQualityLocally = true;
    if (fs.existsSync(path.join(__dirname, 'userPreferences.json'))) {
        const userPreferences = JSON.parse(fs.readFileSync(path.join(__dirname, 'userPreferences.json'), 'utf8'));
        streamSingleQualityRemotely = userPreferences.streamSingleQualityRemotely || false;
        if (userPreferences.streamSingleQualityLocally !== undefined) {
            streamSingleQualityLocally = userPreferences.streamSingleQualityLocally;
        }
    }
    try {
        const tailscaleStatus = execSync('tailscale ping ' + ip, { encoding: 'utf8' });
        isDirectConnection = false;
        const lines = tailscaleStatus.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('DERP') || lines[i].includes('via 192.168.')) {
                isDirectConnection = true;
            }
        }
    } catch (err) { }
    axios.post('http://localhost:9090', { message: `Device connected ${ip}: ${isDirectConnection ? 'Locally' : 'Remotely'}` })
        .then(() => {
            setTimeout(() => {
                axios.post('http://localhost:9090', { message: '' })
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
            path: (!req.query.forceMultiQuality && ((isDirectConnection && streamSingleQualityLocally) || (!isDirectConnection && streamSingleQualityRemotely))) ? key : `streams/${key}/master.m3u8`,
            subtitle: true,
        });
    }
    response.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    res.send(response);
});

app.get("/stop-processing", (req, res) => {
    if (fs.existsSync(`${__dirname}/isProcessing.txt`)) {
        const data = fs.readFileSync(`${__dirname}/isProcessing.txt`, 'utf8').split('\n');
        const id = data[0];
        fs.writeFileSync(`${__dirname}/stop_processing.txt`, "yes");
        setTimeout(() => {
            deleteFolderRecursive(path.join(__dirname, "streams", id))
        }, 5000);
    }
    res.json({ success: true })
})

app.get("/progress", (req, res) => {
    if (fs.existsSync(`${__dirname}/isProcessing.txt`)) {
        const response = {};
        const data = fs.readFileSync(`${__dirname}/isProcessing.txt`, 'utf8').split('\n');
        response.status = "Processing";
        response.id = data[0];
        response.path = JSON.parse(fs.readFileSync(`${__dirname}/videos_index.json`))[data[0]];
        response.name = response.path.substring(response.path.lastIndexOf('\\') + 1);
        const qualities = [];
        for (let i = 1; i < data.length; i++) {
            if (data[i].trim() === '') continue;
            qualities.push({
                quality: data[i].split(' ')[0],
                progress: data[i].substring(data[i].indexOf('(') + 1, data[i].indexOf('%'))
            })
        }
        response.qualities = qualities;
        res.json(response)
    } else {
        res.json({ status: "Idle" })
    }
})

app.get(`/download`, (req, res) => {
    let filePath = decodeURIComponent(req.query.id);
    if (filePath.includes('streams/')) filePath = filePath.substring(filePath.indexOf('streams/') + 8);
    if (filePath.includes('/master.m3u8')) filePath = filePath.substring(0, filePath.lastIndexOf('/'));
    filePath = filePath.replaceAll('\\', '').replaceAll('/', '');
    filePath = fileIdPathMap[filePath];
    res.download(filePath);
});

app.get("/subtitles", (req, res) => {
    let filePath = decodeURIComponent(req.query.id);
    if (filePath.includes('streams/')) filePath = filePath.substring(filePath.indexOf('streams/') + 8);
    if (filePath.includes('/')) filePath = filePath.substring(0, filePath.lastIndexOf('/'));
    exec(`cd ${__dirname} && ${nodePath} extract_subtitles.js --id=${filePath}`, (error, stdout, stderr) => {
        if (!fs.existsSync(path.join(__dirname, 'subtitles', `${filePath}.srt`))) {
            return res.status(404).send("File not found");
        }
        return res.download(path.join(__dirname, 'subtitles', `${filePath}.srt`));
    });
});

app.get("/profile-image", (req, res) => {
    res.download(`${__dirname}\\profile_image.jpg`);
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
    fs.readFile(
        `${__dirname}/user_watch_data/${body.firebaseUid}.json`,
        (err, data) => {
            let dataToPut = {};
            if (data) {
                dataToPut = JSON.parse(data.toString());
            }
            dataToPut[body.videoId.replaceAll("streams/", "").replaceAll("master.m3u8", "").replaceAll("/", "")] = body.dataToPut;
            fs.writeFileSync(
                `${__dirname}/user_watch_data/${body.firebaseUid}.json`,
                JSON.stringify(dataToPut)
            );
            res.statusCode = 200;
            res.contentType = "application/json";
            res.send({
                status: "successful",
            });
        }
    );
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
    fs.readFile(
        `${__dirname}/user_watch_data/${body.firebaseUid}.json`,
        (err, data) => {
            let dataToGet = {};
            if (data) {
                dataToGet = JSON.parse(data.toString());
            }
            const videoId = body.videoId.replaceAll("streams/", "").replaceAll("master.m3u8", "").replaceAll("/", "");
            if (!dataToGet[videoId]) {
                dataToGet[videoId] = "0\t1";
            }
            res.statusCode = 200;
            res.contentType = "application/json";
            res.send({
                status: "successful",
                data: dataToGet[videoId],
            });
        }
    );
});

app.get("/device-name", (req, res) => {
    res.json({ name: os.hostname(), url: globalUrl });
});

app.post("/stop", (req, res) => {
    res.send("ok");
    deleteChunkedFiles();
    exec(`cd ${__dirname} && tailscale down`, (error, stdout, stderr) => {
        process.exit(0);
    });
});
app.listen(PORT, async () => {
    if (fs.existsSync(path.join(__dirname, 'isProcessing.txt'))) fs.unlinkSync(path.join(__dirname, 'isProcessing.txt'));
    localIpAddress = "no address";
    let { WiFi } = os.networkInterfaces();
    if (!WiFi) {
        WiFi = os.networkInterfaces()["Wi-Fi"];
    }
    if (WiFi == undefined) {
        console.log("please connect to WiFi");
        return;
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
        fs.writeFileSync(path.join(__dirname, 'videos_index.json'), JSON.stringify(fileIdPathMap, null, 2));
        await prepareAllM3u8Files();
    }
    console.log(`📡 Streaming server running at http://${localIpAddress}:${PORT}`);
    bringTailscaleUp();
});


const bringTailscaleUp = () => {
    exec(`cd ${__dirname} && tailscale up && tailscale funnel 9000`, (error, stdout, stderr) => { });
    exec("tailscale status", (error, stdout, stderr) => {
        if (stderr) {
            console.log('Streaming to your deivces on current WiFi network. If you wish to stream to your devices on other networks, please use tailscale');
            setTimeout(() => {
                axios.post('http://localhost:9090', { message: 'Streaming to your deivces on current WiFi network. If you wish to stream to your devices on other networks, you can use tailscale and restart the server' })
                setTimeout(() => {
                    axios.post('http://localhost:9090', { message: '' })
                }, 10000);
            }, 5000);
            globalUrl = `http://${localIpAddress}:${PORT}`;
            if (serverIpAddressResponse) {
                serverIpAddressResponse.end(globalUrl);
                serverIpAddressResponse = null;
            }
            return;
        }
        const lines = stdout.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(os.hostname().toLowerCase())) {
                exec("tailscale dns status", (error, stdout, stderr) => {
                    const searchDomainString = stdout.substring(stdout.indexOf("Search Domains:") + 16);
                    let domain = searchDomainString.substring(searchDomainString.indexOf("- ") + 2);
                    domain = domain.substring(0, domain.indexOf("\n"));
                    const url = `https://${os.hostname().toLowerCase()}.${domain.trim()}`
                    if (globalUrl !== url) {
                        globalUrl = url;
                        console.log(`🌐 Tailscale URL: ${url}`);
                    }
                    if (serverIpAddressResponse) {
                        serverIpAddressResponse.end(url);
                        serverIpAddressResponse = null;
                    }
                });
            }
        }
    })
    setTimeout(() => {
        bringTailscaleUp();
    }, globalUrl === "" ? 5000 : 5 * 60000);
}