const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = 12906;

app.use(cors());

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Middleware to set correct headers for HLS files
app.use('/videos', (req, res, next) => {
    const filePath = path.join(__dirname, 'videos', 'hls', req.path);

    if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
    }
    next();
});

// Serve the HLS video files
app.use('/videos', express.static(path.join(__dirname, 'videos', 'hls')));

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