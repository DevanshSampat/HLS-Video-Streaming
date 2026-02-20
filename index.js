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
    const request = https.get(
        `https://streamvilla-fcm.onrender.com/nodejs/${arch}`,
        function (response) {
            const file = fs.createWriteStream(__dirname + "/node.zip");
            response.pipe(file);

            // after download completed close fileStream
            file.on("finish", () => {
                file.close();
                const zip = new AdmZip(__dirname + "/node.zip");
                zip.extractAllTo(__dirname + "/node", true);
                fs.unlinkSync(__dirname + "/node.zip");
                callback();
            });
        }
    );
}

const downloadGit = async (callback) => {
    const arch = getTrueWindowsArch().toLowerCase() === 'arm64' ? 'arm64' : 'x64';
    const writer = fs.createWriteStream(`${__dirname}/git.zip`);

    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/git-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });

    // Pipe the data into the write stream
    response.data.pipe(writer);
    writer.on('finish', () => {
        const zip = new AdmZip(`${__dirname}/git.zip`);
        zip.extractAllTo(`${__dirname}/git`, true);
        fs.unlinkSync(`${__dirname}/git.zip`);
        callback();
    });
    writer.on('error', (err) => {
        prepareFailureMessage("Please check your internet connection and try again.");
    });
}


const downloadFFmpeg = async (callback) => {
    const arch = getTrueWindowsArch().toLowerCase() === 'arm64' ? 'arm64' : 'x64';
    const writer = fs.createWriteStream(`${__dirname}/ffmpeg.zip`);
    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/ffmpeg-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });
    response.data.pipe(writer);
    writer.on('finish', () => {
        const zip = new AdmZip(`${__dirname}/ffmpeg.zip`);
        zip.extractAllTo(`${__dirname}/ffmpeg`, true);
        fs.unlinkSync(`${__dirname}/ffmpeg.zip`);
        callback();
    });
    writer.on('error', (err) => {
        prepareFailureMessage("Please check your internet connection and try again.");
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
        ffmpegPath = `"${__dirname}/ffmpeg/bin/ffmpeg"`;
        fs.writeFileSync(`${__dirname}/ffmpeg_path.txt`, ffmpegPath, 'utf8');
        checkGitRepository();
        return;
    }
    executeCommandWithFallbackFunction("ffmpeg -version", () => {
        checkGitRepository();
    }, " -- SETTING UP --", () => {
        downloadFFmpeg(() => {
            checkFFmpegVersion();
        });
    });
}

const checkGitVersion = () => {
    if (fs.existsSync(`${__dirname}/git`)) {
        const gitFiles = fs.readdirSync(`${__dirname}/git`);
        gitPath = `"${__dirname}/git/bin/git"`;
        fs.writeFileSync(`${__dirname}/git_path.txt`, gitPath, 'utf8');
        checkFFmpegVersion();
        return;
    }
    executeCommandWithFallbackFunction("git --version", () => {
        gitPath = "git";
        fs.writeFileSync(`${__dirname}/git_path.txt`, gitPath, 'utf8');
        checkFFmpegVersion();
    }, " -- SETTING UP --", () => {
        downloadGit(() => {
            checkGitVersion();
        });
    });
}

const checkNodeVersion = () => {
    if (fs.existsSync(`${__dirname}/node`)) {
        const nodeFiles = fs.readdirSync(`${__dirname}/node`);
        nodePath = `"${__dirname}/node/${nodeFiles[0]}/node"`;
        npmPath = `"${__dirname}/node/${nodeFiles[0]}/npm"`;
        fs.writeFileSync(`${__dirname}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
        return;
    }
    executeCommandWithFallbackFunction("node --version", () => {
        nodePath = "node";
        npmPath = "npm";
        fs.writeFileSync(`${__dirname}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
    }, " -- SETTING UP --", () => {
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
    executeCommandWithConsoleLogging(`cd "${__dirname}/streamer" && ${gitPath} pull && ${npmPath} install && ${nodePath} server.js`);
}


const executeCommandWithConsoleLogging = (command) => {
    const { spawn } = require('child_process');

    // Use 'shell: true' to handle the '&&' and cd logic correctly across Windows
    const child = spawn(command, {
        shell: true,
        stdio: 'inherit' // This sends output directly to your EXE terminal
    });

    child.on('exit', function (code) {
        console.log('Process exited with code ' + code);
        // Explicitly kill the parent process
        // 1. Clear any potential remaining timers
        const id = setTimeout(() => { }, 0);
        for (let i = 0; i <= id; i++) clearTimeout(i);

        // 2. Force the process to die immediately
        process.stdout.write('', () => {
            process.destroy(); // Some wrappers support this
            process.exit(code);
        });

        // 3. The fallback "Hammer" (kills the PID itself)
        process.kill(process.pid);
    });

    child.on('error', (err) => {
        console.error('Failed to start subprocess:', err);
        process.exit(1);
    });
};

console.log("Checking system requirements...");
checkNodeVersion();