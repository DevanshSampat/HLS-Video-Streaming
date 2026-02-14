const { exec } = require('child_process');
const fs = require('fs');
const https = require("https");
const AdmZip = require("adm-zip");
const os = require('os');
const axios = require('axios');

let nodePath = 'node';
let npmPath = 'npm';
let gitPath = 'git';
let ffmpegPath = 'ffmpeg';

const { execSync } = require('child_process');

function getTrueWindowsArch() {
    try {
        // We use 'Get-CimInstance' because it's the modern way to ask the hardware
        // 12 is the code for ARM64, 9 is x64
        const command = 'powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).Architecture"';
        const result = execSync(command).toString().trim();

        if (result === '12') return 'arm64';
        if (result === '9') return 'x64';
        if (result === '0') return 'x86';

        return result; // Or fallback
    } catch (e) {
        // If PowerShell fails, we check the Registry "Native" key
        try {
            const regCommand = 'reg query "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment" /v PROCESSOR_ARCHITECTURE';
            const regResult = execSync(regCommand).toString();
            if (regResult.includes('ARM64')) return 'arm64';
            if (regResult.includes('AMD64')) return 'x64';
        } catch (regErr) {
            return process.arch;
        }
    }
}


const prepareFailureMessage = (message) => {
    console.log(message);
    setTimeout(() => {
        process.exit(1);
    }, 10000)
}

const executeCommand = (command, callback, failureMessage) => {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            prepareFailureMessage(failureMessage);
            return;
        }
        callback();
    });
}

const downloadNodeJs = (callback) => {
    const arch = getTrueWindowsArch().toLowerCase() === 'arm64' ? 'arm64' : 'x64';
    console.log(`Downloading Node JS for windows ${arch}, this may take some time`);
    const request = https.get(
        `https://streamvilla-fcm.onrender.com/nodejs/${arch}`,
        function (response) {
            const file = fs.createWriteStream(__dirname + "/node.zip");
            response.pipe(file);

            // after download completed close fileStream
            file.on("finish", () => {
                file.close();
                console.log("Download Completed, Unzipping Node js...");
                const zip = new AdmZip(__dirname + "/node.zip");
                zip.extractAllTo(__dirname + "/node", true);
                fs.unlinkSync(__dirname + "/node.zip");
                console.log("Node JS setup completed");
                callback();
            });
        }
    );
}

const downloadGit = async (callback) => {
    const arch = getTrueWindowsArch().toLowerCase() === 'arm64' ? 'arm64' : 'x64';
    console.log(`Downloading Git for windows ${arch}, this may take some time`);
    const writer = fs.createWriteStream(`${__dirname}/git.zip`);

    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/git-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });

    // Pipe the data into the write stream
    response.data.pipe(writer);
    writer.on('finish', () => {
        console.log("Download Completed, Unzipping Git...");
        const zip = new AdmZip(`${__dirname}/git.zip`);
        zip.extractAllTo(`${__dirname}/git`, true);
        fs.unlinkSync(`${__dirname}/git.zip`);
        console.log("Git setup completed");
        callback();
    });
    writer.on('error', (err) => {
        console.error("Error downloading Git:", err);
        prepareFailureMessage("Failed to download Git. Please check your internet connection and try again.");
    });
}


const downloadFFmpeg = async (callback) => {
    const arch = getTrueWindowsArch().toLowerCase() === 'arm64' ? 'arm64' : 'x64';
    console.log(`Downloading FFmpeg for windows ${arch}, this may take some time`);
    const writer = fs.createWriteStream(`${__dirname}/ffmpeg.zip`);
    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/ffmpeg-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });
    response.data.pipe(writer);
    writer.on('finish', () => {
        console.log("FFmpeg download completed.");
        const zip = new AdmZip(`${__dirname}/ffmpeg.zip`);
        zip.extractAllTo(`${__dirname}/ffmpeg`, true);
        fs.unlinkSync(`${__dirname}/ffmpeg.zip`);
        console.log("FFmpeg setup completed");
        callback();
    });
    writer.on('error', (err) => {
        console.error("Error downloading FFmpeg:", err);
        prepareFailureMessage("Failed to download FFmpeg. Please check your internet connection and try again.");
    });
}

const executeCommandWithFallbackFunction = (command, callback, failureMessage, fallbackFunction) => {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.log(failureMessage);
            fallbackFunction();
            return;
        }
        callback();
    });
}


const checkFFmpegVersion = () => {
    if (fs.existsSync(`${__dirname}/ffmpeg`)) {
        console.log("FFmpeg is installed.");
        const ffmpegFiles = fs.readdirSync(`${__dirname}/ffmpeg`);
        ffmpegPath = `"${__dirname}/ffmpeg/bin/ffmpeg"`;
        fs.writeFileSync(`${__dirname}/ffmpeg_path.txt`, ffmpegPath, 'utf8');
        checkGitRepository();
        return;
    }
    executeCommandWithFallbackFunction("ffmpeg -version", () => {
        console.log("FFmpeg is installed.");
        checkGitRepository();
    }, " -- FFMPEG SETUP --", () => {
        downloadFFmpeg(() => {
            checkFFmpegVersion();
        });
    });
}

const checkGitVersion = () => {
    if (fs.existsSync(`${__dirname}/git`)) {
        console.log("Git is installed.");
        const gitFiles = fs.readdirSync(`${__dirname}/git`);
        gitPath = `"${__dirname}/git/bin/git"`;
        fs.writeFileSync(`${__dirname}/git_path.txt`, gitPath, 'utf8');
        checkFFmpegVersion();
        return;
    }
    executeCommandWithFallbackFunction("git --version", () => {
        console.log("Git is installed.");
        gitPath = "git";
        fs.writeFileSync(`${__dirname}/git_path.txt`, gitPath, 'utf8');
        checkFFmpegVersion();
    }, " -- GIT SETUP --", () => {
        downloadGit(() => {
            checkGitVersion();
        });
    });
}

const checkNodeVersion = () => {
    if (fs.existsSync(`${__dirname}/node`)) {
        console.log("Node.js is installed.");
        const nodeFiles = fs.readdirSync(`${__dirname}/node`);
        nodePath = `"${__dirname}/node/${nodeFiles[0]}/node"`;
        npmPath = `"${__dirname}/node/${nodeFiles[0]}/npm"`;
        fs.writeFileSync(`${__dirname}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
        return;
    }
    executeCommandWithFallbackFunction("node --version", () => {
        console.log("Node.js is installed.");
        nodePath = "node";
        npmPath = "npm";
        fs.writeFileSync(`${__dirname}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
    }, " -- NODE JS SETUP --", () => {
        downloadNodeJs(() => {
            checkNodeVersion();
        });
    });
}


const checkGitRepository = () => {
    if (fs.existsSync(`${__dirname}/streamer`)) {
        startServer();
    } else {
        exec(`${gitPath} clone https://github.com/DevanshSampat/HLS-Video-Streaming.git "${__dirname}/streamer"`, (error, stdout, stderr) => {
            if (error) {
                prepareFailureMessage("Failed to clone the Git repository.");
            } else {
                startServer();
            }
        });
    }
}

const startServer = () => {
    console.log("Starting server...");
    if (fs.existsSync(`${__dirname}/path.txt`)) {
        fs.writeFileSync(`${__dirname}/streamer/path.txt`, fs.readFileSync(`${__dirname}/path.txt`, 'utf8'), 'utf8');
        fs.unlinkSync(`${__dirname}/path.txt`);
    }
    executeCommandWithConsoleLogging(`cd "${__dirname}/streamer" && ${gitPath} pull && ${npmPath} run start`);
}


const executeCommandWithConsoleLogging = (command) => {
    let spawn = require('child_process').spawn,
        list = spawn('cmd');

    list.stdout.on('data', function (data) {
        console.log(data.toString());
    });

    list.stderr.on('data', function (data) {
        console.log(data.toString());
    });

    list.on('exit', function (code) {
        console.log('process exited with code ' + code);
        process.exit(code);
    });

    list.stdin.write(`${command}\n`);
    list.stdin.end();
}

checkNodeVersion();