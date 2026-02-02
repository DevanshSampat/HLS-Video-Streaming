const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
ffmpeg.setFfmpegPath('ffmpeg');

const subtitlesDir = path.join(__dirname, 'extracted_subtitles');
let id = null;

// Create output directory
if (!fs.existsSync(subtitlesDir)) {
    fs.mkdirSync(subtitlesDir, { recursive: true });
}

// Get all video files
const videoFiles = [];
const args = process.argv.slice(2);
if(!fs.existsSync(path.join(__dirname, 'videos_index.json'))) return;
const allVideos = JSON.parse(fs.readFileSync(path.join(__dirname, 'videos_index.json'), 'utf-8'));
if (args.length > 0) {
    args.forEach(arg => {
        if (arg.startsWith('--id=')) {
            id = arg.substring(5);
            if (allVideos[id]) {
                videoFiles.push(allVideos[id]);
            } else {
                id = null; // reset id if not found
            }
        }
    });
}
if (id === null) return;
console.log(`📁 Found ${videoFiles.length} video files\n`);

let allEnglishSubtitles = [];

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

// Process each video file
async function processVideo(videoPath, index) {
    // Clean the temp directory for each video
    deleteFolderRecursive(subtitlesDir);
    fs.mkdirSync(subtitlesDir, { recursive: true });

    return new Promise((resolve, reject) => {
        const videoName = path.basename(videoPath, path.extname(videoPath));
        console.log(`🎬 [${index + 1}/${videoFiles.length}] Analyzing: ${path.basename(videoPath)}`);
        if (fs.existsSync(path.join(__dirname, 'subtitles', `${id}.srt`))) {
            console.log(`   ℹ️  Subtitles already extracted\n`);
            return resolve();
        }

        ffmpeg.ffprobe(videoPath, async (err, metadata) => {
            if (err) {
                console.error(`❌ Error probing ${path.basename(videoPath)}: ${err.message}`);
                return resolve();
            }

            // Find all subtitle streams
            const subtitleStreams = metadata.streams.filter(s => s.codec_type === 'subtitle');

            if (subtitleStreams.length === 0) {
                console.log(`   ℹ️  No subtitles found\n`);
                return resolve();
            }

            console.log(`   📝 Found ${subtitleStreams.length} subtitle stream(s)`);

            // Filter English subtitles
            const englishSubtitles = subtitleStreams.filter(s => {
                const lang = s.tags?.language?.toLowerCase() || '';
                const title = s.tags?.title?.toLowerCase() || '';
                return lang.includes('eng') || lang.includes('en') ||
                    title.includes('english') || title.includes('eng');
            });

            if (englishSubtitles.length === 0) {
                console.log(`   ⚠️  No English subtitles found\n`);
                return resolve();
            }

            console.log(`   ✅ Found ${englishSubtitles.length} English subtitle stream(s)`);

            // Extract each English subtitle
            const extractPromises = englishSubtitles.map((sub, subIndex) => {
                return new Promise((resolveExtract, rejectExtract) => {
                    const lang = sub.tags?.language || 'eng';
                    const title = sub.tags?.title || `Track_${subIndex}`;
                    const codec = sub.codec_name || 'unknown';

                    // Determine file extension based on codec
                    let ext = 'srt';
                    if (codec === 'ass') ext = 'ass';
                    else if (codec === 'webvtt') ext = 'vtt';
                    else if (codec === 'subrip') ext = 'srt';

                    const outputFileName = `${videoName}_${lang}_${title.replace(/[^a-zA-Z0-9]/g, '_')}_stream${sub.index}.${ext}`;
                    const outputPath = path.join(subtitlesDir, outputFileName);

                    console.log(`      ⏳ Extracting stream #${sub.index} (${codec}) -> ${outputFileName}`);

                    ffmpeg(videoPath)
                        .outputOptions([
                            '-map', `0:${sub.index}`,
                            '-c', 'copy'
                        ])
                        .output(outputPath)
                        .on('error', (err) => {
                            console.error(`      ❌ Failed to extract: ${err.message}`);
                            resolveExtract(); // Continue even if one fails
                        })
                        .on('end', () => {
                            // Get file size
                            const stats = fs.statSync(outputPath);
                            const sizeKB = (stats.size / 1024).toFixed(2);
                            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);

                            console.log(`      ✅ Extracted: ${sizeKB} KB (${sizeMB} MB)`);

                            allEnglishSubtitles.push({
                                videoFile: path.basename(videoPath),
                                streamIndex: sub.index,
                                language: lang,
                                title: title,
                                codec: codec,
                                outputFile: outputFileName,
                                outputPath: outputPath,
                                sizeBytes: stats.size,
                                sizeKB: parseFloat(sizeKB),
                                sizeMB: parseFloat(sizeMB)
                            });

                            resolveExtract();
                        })
                        .run();
                });
            });

            // Wait for all extractions to complete
            await Promise.all(extractPromises);
            console.log('');

            // NOW read and sort the extracted files (after extraction is done)
            const files = fs.readdirSync(subtitlesDir);

            if (files.length > 0) {
                files.sort((a, b) => {
                    const sizeA = fs.statSync(path.join(subtitlesDir, a)).size;
                    const sizeB = fs.statSync(path.join(subtitlesDir, b)).size;
                    return sizeB - sizeA;
                });

                const largest = files[0];
                console.log(`   📊 Largest subtitle: ${largest}`);
                const data = fs.readFileSync(path.join(subtitlesDir, largest), 'utf-8');

                let index = 0;
                let dataArray = data.replace(/\r\n/g, '\n').split('\n');
                let processedData = '';
                while (index < dataArray.length) {
                    if (dataArray[index].trim() === '') {
                        if (index + 1 < dataArray.length && /^\d+$/.test(dataArray[index + 1].trim())) {
                            processedData += '\n';
                        }
                    } else {
                        processedData += dataArray[index] + '\n';
                    }
                    index++;
                }
                // Save to subtitles folder
                if (!fs.existsSync(path.join('subtitles'))) {
                    fs.mkdirSync(path.join('subtitles'));
                }
                fs.writeFileSync(path.join('subtitles', `${id}.srt`), processedData);
                console.log(`   ✨ Saved to: subtitles/${id}.srt\n`);
            }

            resolve();
        });
    });
}

// Main execution
async function main() {
    console.log('🚀 Starting subtitle extraction...\n');

    for (let i = 0; i < videoFiles.length; i++) {
        await processVideo(videoFiles[i], i);
    }
    deleteFolderRecursive(subtitlesDir);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 EXTRACTION SUMMARY');
    console.log('═══════════════════════════════════════════════════════════\n');

    if (allEnglishSubtitles.length === 0) {
        console.log('❌ No English subtitles found in any video files.');
        return;
    }

    console.log(`✅ Total English subtitles extracted: ${allEnglishSubtitles.length}\n`);

    // Sort by file size (descending)
    allEnglishSubtitles.sort((a, b) => b.sizeBytes - a.sizeBytes);

    console.log('📋 All English Subtitles (sorted by size):');
    console.log('─────────────────────────────────────────────────────────────\n');

    allEnglishSubtitles.forEach((sub, index) => {
        console.log(`${index + 1}. ${sub.outputFile}`);
        console.log(`   Video: ${sub.videoFile}`);
        console.log(`   Size: ${sub.sizeKB} KB (${sub.sizeMB} MB)`);
        console.log(`   Language: ${sub.language} | Title: ${sub.title} | Codec: ${sub.codec}`);
        console.log('');
    });
}

main().catch(console.error);