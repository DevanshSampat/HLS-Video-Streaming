const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { ALL } = require('dns');

console.log(fs.existsSync(path.join(__dirname, 'ffmpeg')) ? `${__dirname}/ffmpeg/bin/ffmpeg.exe` : 'ffmpeg');
ffmpeg.setFfmpegPath(fs.existsSync(path.join(__dirname, 'ffmpeg')) ? `${__dirname}/ffmpeg/bin/ffmpeg.exe` : 'ffmpeg');
// === CONFIGURATION ===
let OUTPUT_DIR = path.join(__dirname, 'streams');
let INPUT_FILE = '';
let id = null;
let lastFileUpdateTime = 0;

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// function shuffleArray(array) {
//     let currentIndex = array.length;
//     let randomIndex;

//     // While there remain elements to shuffle.
//     while (currentIndex !== 0) {
//         // Pick a remaining element.
//         randomIndex = Math.floor(Math.random() * currentIndex);
//         currentIndex--;

//         // And swap it with the current element.
//         [array[currentIndex], array[randomIndex]] = [
//             array[randomIndex],
//             array[currentIndex],
//         ];
//     }

//     return array;
// }

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

const COMMON_OPTIONS = [
    '-hls_time', '6',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event', // CHANGED: 'event' allows live playback
    '-sn', '-dn', '-map_metadata', '-1',
    '-max_muxing_queue_size', '1024'
];

// === HELPER: Transcode Single Track ===
function processTrack(input, mapIndex, output, isVideo, opts = {}, metadata, quality, validQualities) {
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(input).addOutput(output);
        let specific = ['-map', `0:${mapIndex}`];

        if (isVideo) {
            // Ensure even height for encoder compatibility
            const safeHeight = Math.round(opts.height / 2) * 2;
            specific.push(
                '-an', '-c:v', 'libx264', '-vf', `scale=-2:${safeHeight}`,
                '-b:v', opts.bitrate, '-maxrate', opts.bitrate, '-bufsize', `${parseInt(opts.bitrate) * 2}k`,
                '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'veryfast',
                '-force_key_frames', 'expr:gte(t,n_forced*6)', '-sc_threshold', '0'
            );
        } else {
            specific.push('-vn', '-c:a', 'aac', '-ac', '2', '-ar', '44100');
        }

        cmd.outputOptions([...specific, ...COMMON_OPTIONS, '-hls_segment_filename', opts.segPath]);

        let startTime = Date.now();
        // Log start but don't spam progress for every single track to keep terminal clean
        console.log(`\n▶️  Starting: ${path.basename(output)}`);
        if (isVideo) cmd.on('progress', (p) => {
            process.stdout.write(`⏳ Processing: ${p.timemark} \r`)
            updateCurrentQualityOnProcessingFile(quality, validQualities, p.timemark, metadata);
        });

        cmd.on('error', (err) => {
            console.error(`\n❌ FAILED: ${path.basename(output)}`);
            reject(err);
        })
            .on('end', () => {
                const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
                console.log(`\n✅ Completed: ${path.basename(output)} (${duration} min)`);
                resolve();
            });

        cmd.run();
    });
}

// === HELPER: Update Master Playlist ===
function updateMasterPlaylist(activeQualities, audioTracks) {
    if (activeQualities.length === 0) return;

    let master = '#EXTM3U\n#EXT-X-VERSION:3\n';
    audioTracks.forEach((t, i) => {
        master += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="stereo",LANGUAGE="${t.lang}",NAME="${t.name}",DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,URI="${t.id}.m3u8"\n`;
    });

    [...activeQualities].sort((a, b) => {
        return a.height - b.height; // Sort from lowest to highest
    }).forEach(q => {
        master += `#EXT-X-STREAM-INF:BANDWIDTH=${(parseInt(q.bitrate) + 192) * 1000},RESOLUTION=1280x${q.height},AUDIO="stereo"\nvideo_${q.height}p.m3u8\n`;
    });

    fs.writeFileSync(path.join(OUTPUT_DIR, 'master.m3u8'), master);
    console.log('📝 Master playlist updated (new quality available for streaming).');
}

// === MAIN ===
async function main() {
    const videoDir = path.join(__dirname, 'videos');
    if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir);
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("❌ Please provide an input video file using --id=");
        return;
    }
    if (!fs.existsSync(path.join(__dirname, 'videos_index.json'))) return;
    args.forEach(arg => {
        if (arg.startsWith('--id=')) {
            id = arg.substring(5);
            const allVideos = JSON.parse(fs.readFileSync(path.join(__dirname, 'videos_index.json'), 'utf-8'));
            if (allVideos[id]) {
                INPUT_FILE = allVideos[id];
            } else {
                id = null; // reset id if not found
            }
        }
    });
    if (id === null) return;
    const allStreams = fs.readdirSync(path.join(__dirname, 'streams')).sort((a, b) => {
        const aTime = fs.existsSync(path.join(__dirname, 'streams', a, 'createdAt.txt')) ? Number(fs.readFileSync(path.join(__dirname, 'streams', a, 'createdAt.txt'), 'utf-8')) : Number.MAX_SAFE_INTEGER;
        const bTime = fs.existsSync(path.join(__dirname, 'streams', b, 'createdAt.txt')) ? Number(fs.readFileSync(path.join(__dirname, 'streams', b, 'createdAt.txt'), 'utf-8')) : Number.MAX_SAFE_INTEGER;
        return bTime - aTime; // Sort by most recently modified first
    }).map(f => path.join(__dirname, 'streams', f));
    if (allStreams.includes(path.join(__dirname, 'streams', id))) {
        if (fs.readdirSync(path.join(__dirname, 'streams', id)).length > 1) {
            console.log(`🔄 Stream already exists: ${id}`);
            return;
        }
    }
    if (allStreams.includes(path.join(__dirname, 'streams', id))) {
        allStreams.splice(allStreams.indexOf(path.join(__dirname, 'streams', id)), 1); // Remove current stream from deletion consideration
    }
    if (allStreams.length >= 5) {
        const dirToDelete = allStreams[allStreams.length - 1];
        deleteFolderRecursive(dirToDelete);
        console.log(`🗑️  Deleted oldest stream directory: ${path.basename(dirToDelete)}`);
    }
    OUTPUT_DIR = path.join(__dirname, 'streams', id);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`📂 Input: ${path.basename(INPUT_FILE)}`);

    ffmpeg.ffprobe(INPUT_FILE, async (err, metadata) => {
        if (err) return console.error("❌ Metadata error");

        const vStream = metadata.streams.find(s => s.codec_type === 'video');
        const aStreams = metadata.streams.filter(s => s.codec_type === 'audio');
        if (!vStream || aStreams.length === 0) return console.error("❌ Missing streams");

        const validQualities = ALL_VIDEO_QUALITIES.filter(q => q.height <= vStream.height);
        if (validQualities.length === 0 || validQualities[validQualities.length - 1].height !== vStream.height) {
            validQualities.push({ height: vStream.height, bitrate: '2000k' });
        }
        const audioTracks = aStreams.map((s, i) => ({
            index: s.index, id: `audio_${i}`,
            lang: s.tags?.language || 'und', name: s.tags?.title || s.tags?.language || `Track ${i + 1}`
        }));

        const args = process.argv.slice(2);
        let prioritizedQualityIndex = 0;
        let isQualitySpecified = false;
        args.forEach(arg => {
            if (arg.startsWith('--quality=')) {
                isQualitySpecified = true;
                const qHeight = parseInt(arg.substring(10));
                for (let i = 0; i < validQualities.length; i++) {
                    if (validQualities[i].height <= qHeight) {
                        prioritizedQualityIndex = i;
                    }
                }
            }
        });
        if (!isQualitySpecified) {
            for (let i = validQualities.length - 1; i >= 0; i--) {
                const quality = ALL_VIDEO_QUALITIES.find(q => q.height === validQualities[i].height);
                if (quality && quality.height <= 1080) {
                    prioritizedQualityIndex = i;
                    break;
                }
            }
        }

        // Move prioritized quality to the front
        if (prioritizedQualityIndex > 0) {
            const [pq] = validQualities.splice(prioritizedQualityIndex, 1);
            validQualities.unshift(pq);
        }

        try {
            updateMasterPlaylist(validQualities, audioTracks);
            console.log(metadata.format.duration);
            if (fs.existsSync(path.join(__dirname, "isProcessing.txt"))) {
                console.log("⏳ Another process is currently running. Retrying in 5 seconds...");
                setTimeout(() => {
                    main(); // Retry after delay
                }, 5000);
                return;
            }
            console.log(`🎥 Video Stream: #${vStream.index}, ${vStream.width}x${vStream.height}, ${vStream.codec_name}`);
            fs.writeFileSync(path.join(__dirname, "isProcessing.txt"), id);
            // PHASE 1: Audio First (Required for master playlist to work correctly)
            console.log(`\n🎵 PHASE 1: Processing ${audioTracks.length} Audio Tracks...`);
            for (const t of audioTracks) {
                processTrack(INPUT_FILE, t.index, path.join(OUTPUT_DIR, `${t.id}.m3u8`), false, {
                    segPath: path.join(OUTPUT_DIR, `${t.id}_%03d.ts`)
                });
            }

            // PHASE 2: Video Qualities (Update master BEFORE processing starts)
            console.log(`\n🎬 PHASE 2: Processing ${validQualities.map(quality => quality.height).toString()} Video Qualities...`);
            const activeQualities = [];

            for (const q of validQualities) {
                console.log(q);
            }

            for (const q of validQualities) {
                console.log(`\n🔹 Starting processing for ${q.height}p...`);
                updateCurrentQualityOnProcessingFile(q, validQualities, "00:00:00", metadata);
                const isFirst = activeQualities.length === 0;
                // 1. Add to active list immediately
                activeQualities.push(q);
                // 2. Start transcoding this quality. Player will poll and wait for segments.
                await processTrack(INPUT_FILE, vStream.index, path.join(OUTPUT_DIR, `video_${isFirst ? "" : "temp_"}${q.height}p.m3u8`), true, {
                    height: q.height, bitrate: q.bitrate, segPath: path.join(OUTPUT_DIR, `video_${q.height}p_%03d.ts`)
                }, metadata, q, validQualities);
                if (!isFirst) {
                    // 3. Rename temp file to official after processing
                    fs.renameSync(
                        path.join(OUTPUT_DIR, `video_temp_${q.height}p.m3u8`),
                        path.join(OUTPUT_DIR, `video_${q.height}p.m3u8`)
                    );
                }
            }
            fs.writeFileSync(path.join(OUTPUT_DIR, 'createdAt.txt'), `${Date.now()}`);
            console.log(`\n🏁 All processing complete for ${path.basename(INPUT_FILE)}.`);
            fs.unlinkSync(path.join(__dirname, "isProcessing.txt"));
            // Proceed to next file
        } catch (e) {
            console.error("\n💥 Process stopped.");
        }
    });
}

const updateCurrentQualityOnProcessingFile = (quality, allQualities, timeMark, metadata) => {
    let percent = 0;
    timeMark = timeMark.split('.')[0]; // Remove milliseconds
    const timeParts = timeMark.split(':').map(Number);
    if (timeParts.length === 3) {
        const seconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
        percent = metadata.format.duration ? ((seconds / Math.ceil(metadata.format.duration)) * 100).toFixed(2) : "0.00";
    }
    if (lastFileUpdateTime < Date.now() - 2000) { // Limit updates to every 2 seconds
        lastFileUpdateTime = Date.now();
        let dataToPut = id;
        for (const q of allQualities) {
            dataToPut += `\n${q === quality ? " • " : "   "}${q.height}p${q === quality ? ` (${percent}%)` : ""}`;
        }
        fs.writeFileSync(path.join(__dirname, "isProcessing.txt"), dataToPut);
    }
}

main();