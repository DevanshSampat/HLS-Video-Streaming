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
const httpPort = 6969;
let serverIpAddressResponse;

let globalUrl = "";

const fileIdPathMap = {};

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

// Middleware to set correct headers for HLS files
app.use('/stream', (req, res, next) => {
    const filePath = path.join(__dirname, decodeURIComponent(req.path)).replaceAll('\\', '/');
    let id = filePath;
    id = id.substring(id.lastIndexOf('streams/') + 8);
    id = id.substring(0, id.lastIndexOf('/'));
    if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        if (filePath.endsWith('master.m3u8')) {
            if (!fs.existsSync(filePath.substring(0, filePath.lastIndexOf('/')))) {
                execSync(`cd ${__dirname} && node extract_subtitles.js --id=${id}`, (error, stdout, stderr) => { });
                exec(`cd ${__dirname} && node transcode.js --id=${id}${req.query?.maxQuality ? ` --quality=${req.query.maxQuality}` : ""}`, (error, stdout, stderr) => { });
            }
            waitForFile(filePath, 1000, () => {
                if (req.query?.maxQuality) {
                    res.send(filterManifest(fs.readFileSync(filePath, 'utf8'), req.query.maxQuality));
                } else {
                    res.download(filePath);
                }
            });
            return;
        }
    } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
    }
    next();
});

const waitForFile = (filePath, timeout, callback) => {
    if (fs.existsSync(filePath)) {
        return callback();
    }
    setTimeout(() => {
        waitForFile(filePath, timeout, callback);
    }, timeout);
}

// Serve the HLS video files
app.use('/stream', (req, res) => {
    const filePath = path.join(__dirname, decodeURIComponent(req.path)).replaceAll('\\', '/');
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send("File not found");
});

app.get('/', async (req, res) => {
    res.send(await si.battery());
});

app.get("/videos", (req, res) => {
    res.statusCode = 200;
    res.contentType = "application/json";
    const response = [];
    for (const key in fileIdPathMap) {
        const filePath = fileIdPathMap[key];
        const fileName = path.basename(filePath);
        response.push({
            name: fileName,
            path: `streams/${key}/master.m3u8`,
            subtitle: true,
        });
    }
    response.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    res.send(response);
});


app.get(`/download`, (req, res) => {
    let filePath = decodeURIComponent(req.query.id);
    filePath = filePath.substring(filePath.indexOf('streams/') + 8);
    filePath = filePath.substring(0, filePath.lastIndexOf('/'));
    filePath = fileIdPathMap[filePath];
    res.download(filePath);
});

app.get("/subtitles", (req, res) => {
    let filePath = decodeURIComponent(req.query.id);
    filePath = filePath.substring(filePath.indexOf('streams/') + 8);
    filePath = filePath.substring(0, filePath.lastIndexOf('/'));
    if(!fs.existsSync(path.join(__dirname, 'subtitles'))) {
        return res.status(404).send("File not found");
    }
    const files = fs.readdirSync(path.join(__dirname, 'subtitles'));
    for (let i = 0; i < files.length; i++) {
        if (files[i].substring(0, files[i].lastIndexOf('.')) === (filePath)) {
            return res.download(path.join(__dirname, 'subtitles', files[i]));
        }
    }
    return res.status(404).send("File not found");
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
            dataToPut[body.videoId] = body.dataToPut;
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
            if (!dataToGet[body.videoId]) {
                dataToGet[body.videoId] = "0\t1";
            }
            res.statusCode = 200;
            res.contentType = "application/json";
            res.send({
                status: "successful",
                data: dataToGet[body.videoId],
            });
        }
    );
});

app.get("/device-name", (req, res) => {
    res.json({ name: os.hostname(), url: globalUrl });
});

app.post("/stop", (req, res) => {
    res.send("ok");
    process.exit(0);
});
app.listen(PORT, () => {
    if (fs.existsSync(path.join(__dirname, 'isProcessing.txt'))) fs.unlinkSync(path.join(__dirname, 'isProcessing.txt'));
    let address = "no address";
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
                address = WiFi[i].address;
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
    }
    console.log(`📡 Streaming server running at http://${address}:${PORT}`);
    bringTailscaleUp();
});


const bringTailscaleUp = () => {
    exec(`cd ${__dirname} && tailscale up && tailscale funnel 9000`, (error, stdout, stderr) => { });
    exec("tailscale status", (error, stdout, stderr) => {
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