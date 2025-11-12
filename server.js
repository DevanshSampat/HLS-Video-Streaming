const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 9000;

app.use(cors());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function filterManifest(originalM3u8, maxQuality) {
    const lines = originalM3u8.split('\n');
    let output = [];
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
                    output.push(line);
                    keepNextUri = true;
                } else {
                    keepNextUri = false;
                }
            } else {
                // If no resolution tag, standard says keep it or decide a default.
                // Usually safe to keep if you can't determine quality.
                output.push(line);
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

    return output.join('\n');
}

// Middleware to set correct headers for HLS files
app.use('/stream', (req, res, next) => {
    const filePath = path.join(__dirname, decodeURIComponent(req.path));

    if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        if(filePath.endsWith('master.m3u8')) {
            if(req.query?.maxQuality) {
                console.log(`Filtering master playlist for max quality: ${req.query.maxQuality}`);
                return res.send(filterManifest(fs.readFileSync(filePath, 'utf8'), req.query.maxQuality));
            }
            return res.download(filePath);
        }
    } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
    }
    console.log(`${filePath.substring(filePath.lastIndexOf('\\streams\\') + 9)}`);
    next();
});

// Serve the HLS video files
app.use('/stream', (req, res) => {
    const filePath = decodeURIComponent(req.path);
    res.sendFile(path.join(__dirname, filePath));
});

app.get('/', (req, res) => {
    res.send("HLS Video Streaming Server is running.");
});

app.get("/videos", (req, res) => {
    res.statusCode = 200;
    res.contentType = "application/json";
    const files = fs.readdirSync(path.join(__dirname, 'streams'));
    while (files.indexOf("hls") != -1) {
        files.splice(files.indexOf("hls"), 1);
    }
    const response = [];
    for (let i = 0; i < files.length; i++) {
        response.push({
            name: files[i],
            path: `streams/${files[i]}/master.m3u8`,
            subtitle: false
        });
    }
    res.send(response);
});

app.get(`/download`, (req, res) => {
    const files = fs.readdirSync(path.join(__dirname, 'videos'));
    while (files.indexOf("hls") != -1) {
        files.splice(files.indexOf("hls"), 1);
    }
    const videoPath = path.join(__dirname, 'videos', files[0]);
    res.download(videoPath);
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
    res.json({ name: os.hostname() });
});

app.listen(PORT, () => {
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
    console.log(`📡 Streaming server running at http://${address}:${PORT}`);
});