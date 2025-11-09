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

// Middleware to set correct headers for HLS files
app.use('/stream', (req, res, next) => {
    const filePath = path.join(__dirname, 'videos', 'hls', req.path);

    if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
    }
    console.log(`Serving file: ${req.path}`);
    next();
});

// Serve the HLS video files
app.use('/stream', express.static(path.join(__dirname, 'videos', 'hls')));

app.get('/', (req, res) => {
    res.send("HLS Video Streaming Server is running.");
});

app.get("/videos", (req, res) => {
    res.statusCode = 200;
    res.contentType = "application/json";
    const files = fs.readdirSync(path.join(__dirname, 'videos'));
    while (files.indexOf("hls") != -1) {
        files.splice(files.indexOf("hls"), 1);
    }
    res.send([
        {
            name: files[0].substring(0, files[0].lastIndexOf(".")),
            path: "master.m3u8",
            subtitle: false
        }
    ]);
});

app.get(`/download`, (req, res) => {
    const files = fs.readdirSync(path.join(__dirname, 'videos'));
    while (files.indexOf("hls") != -1) {
        files.splice(files.indexOf("hls"), 1);
    }
    const videoPath = path.join(__dirname, 'videos', files[0]);
    res.download(videoPath);
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