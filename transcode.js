const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfmpegPath('ffmpeg');

// Configuration
const INPUT_FILE = path.join(__dirname, 'videos', 'input.mp4');
const OUTPUT_DIR = path.join(__dirname, 'videos', 'hls');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Helper to get video metadata
function getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata);
        });
    });
}

async function transcode() {
    console.log('🔍 Detecting video quality...');
    const metadata = await getVideoMetadata(INPUT_FILE);
    const videoStream = metadata.streams.find(s => s.codec_type === 'video');
    const originalHeight = videoStream.height;

    console.log(`✅ Original Video Height: ${originalHeight}p`);

    // Define standard qualities
    const renditions = [
        { height: 360, bitrate: '800k' },
        { height: 720, bitrate: '2500k' },
        { height: 1080, bitrate: '5000k' },
        { height: 1440, bitrate: '8000k' },
        { height: 2160, bitrate: '12000k' }
    ];

    // Filter renditions that are feasible (don't upscale)
    const validRenditions = renditions.filter(r => r.height <= originalHeight);

    // If the video is weird (e.g., 500p), ensure we at least have one rendition close to original
    if (validRenditions.length === 0 || validRenditions[validRenditions.length - 1].height < originalHeight) {
        validRenditions.push({ height: originalHeight, bitrate: '1000k' });
    }

    console.log(`⚙️  Starting transcode for: ${validRenditions.map(r => r.height + 'p').join(', ')}`);
    console.log('☕ This may take several minutes depending on video size...');
    runCommandForQuality(validRenditions, 0);
}

async function runCommandForQuality(renditions, index) {
    if (index === renditions.length) {
        console.log('✅ Transcoding finished!');
        createMasterPlaylist(renditions);
        return;
    }
    const rendition = renditions[index];
    console.log(`🔄 Transcoding to ${rendition.height}p...`);
    const command = ffmpeg(INPUT_FILE).output(path.join(OUTPUT_DIR, `video_${rendition.height}p.m3u8`))
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(`?x${rendition.height}`) // Maintain aspect ratio
        .videoBitrate(rendition.bitrate)
        .format('hls')
        .outputOptions([
            '-hls_time 30',           // 30 second chunks
            '-hls_list_size 0',       // Keep all chunks in playlist
            '-hls_segment_filename', path.join(OUTPUT_DIR, `video_${rendition.height}p_%03d.ts`)
        ]);
    command
        .on('error', (err) => console.error('❌ An error occurred: ' + err.message))
        .on('end', () => {
            console.log('✅ Transcoding finished for ' + rendition.height + 'p');
            runCommandForQuality(renditions, index + 1);
        })
        .run();
}

// Generate the master.m3u8 file that links all valid renditions together
function createMasterPlaylist(renditions) {
    console.log('📝 Creating master playlist...');
    let masterContent = '#EXTM3U\n#EXT-X-VERSION:3\n';

    renditions.forEach(r => {
        masterContent += `#EXT-X-STREAM-INF:BANDWIDTH=${parseInt(r.bitrate) * 1000},RESOLUTION=1280x${r.height}\n`;
        masterContent += `video_${r.height}p.m3u8\n`;
    });

    fs.writeFileSync(path.join(OUTPUT_DIR, 'master.m3u8'), masterContent);
    console.log('🚀 Ready to stream! Run server.js now.');
}

transcode();