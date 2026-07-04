const { exec } = require('child_process');
const fs = require('fs');
const https = require("https");
const AdmZip = require("adm-zip");
const os = require('os');
const axios = require('axios');
const path = require('path');

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

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

function downloadWithHomebrew(tool, callback) {
    executeCommandWithFallbackFunction("brew --version", () => {
        const command = `HOMEBREW_NO_AUTO_UPDATE=1 yes | brew install ${tool}`;
        executeCommand(command, callback, `Failed to install ${tool}. Please install it manually and try again.`);
    }, " -- SETTING UP --", () => {
        prepareFailureMessage("homebrew not found");
    });
}

function getTrueMacArch() {
    try {
        const isTranslated = execSync('sysctl -in sysctl.proc_translated').toString().trim() === '1';
        if (isTranslated) return 'arm64';
        const hasArmCpu = execSync('sysctl -in hw.optional.arm64').toString().trim() === '1';
        if (hasArmCpu) return 'arm64';
    } catch (e) {}

    const arch = execSync('uname -m').toString().trim();
    if (arch === 'arm64') return 'arm64';
    if (arch === 'x86_64') return 'x64';
    return 'x64';
}

function getTrueArch(){
    if(process.platform === 'win32') return getTrueWindowsArch().toLowerCase() === 'arm64' ? 'arm64' : 'x64';
    if(process.platform === 'darwin') return getTrueMacArch();
    return process.arch;
}

function getPlatform() {
    if(process.platform === 'win32') return 'windows';
    if(process.platform === 'darwin') return 'mac';
    return 'linux';
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
            console.log(error);
            prepareFailureMessage(failureMessage);
            return;
        }
        callback();
    });
}

const downloadNodeJs = async (callback) => {
    const platform = getPlatform().toLowerCase();
    if(platform === "mac") {
        downloadWithHomebrew("node", callback);
        return;
    }
    const arch = getTrueArch();
    const writer = fs.createWriteStream(`${baseDir}/node.zip`);
    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/nodejs-${platform}-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });

    // Pipe the data into the write stream
    response.data.pipe(writer);
    writer.on('finish', () => {
        const zip = new AdmZip(`${baseDir}/node.zip`);
        zip.extractAllTo(`${baseDir}/node`, true);
        fs.unlinkSync(`${baseDir}/node.zip`);
        callback();
    });
    writer.on('error', (err) => {
        prepareFailureMessage("Please check your internet connection and try again.");
    });
}

const downloadGit = async (callback) => {
    const platform = getPlatform().toLowerCase();
    const arch = getTrueArch();
    if(platform === "mac") {
        downloadWithHomebrew("git", callback);
        return;
    }
    const writer = fs.createWriteStream(`${baseDir}/git.zip`);
    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/git-${platform}-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });

    // Pipe the data into the write stream
    response.data.pipe(writer);
    writer.on('finish', () => {
        const zip = new AdmZip(`${baseDir}/git.zip`);
        zip.extractAllTo(`${baseDir}/git`, true);
        fs.unlinkSync(`${baseDir}/git.zip`);
        callback();
    });
    writer.on('error', (err) => {
        prepareFailureMessage("Please check your internet connection and try again.");
    });
}


const downloadFFmpeg = async (callback) => {
    const platform = getPlatform().toLowerCase();
    if(platform === "mac") {
        downloadWithHomebrew("ffmpeg", callback);
        return;
    }
    const arch = getTrueArch();
    const writer = fs.createWriteStream(`${baseDir}/ffmpeg.zip`);
    const response = await axios({
        url: `https://github.com/DevanshSampat/HLS-Video-Streaming/releases/download/git/ffmpeg-${platform}-${arch}.zip`,
        method: 'GET',
        responseType: 'stream', // Important for Node.js downloads
    });
    response.data.pipe(writer);
    writer.on('finish', () => {
        const zip = new AdmZip(`${baseDir}/ffmpeg.zip`);
        zip.extractAllTo(`${baseDir}/ffmpeg`, true);
        fs.unlinkSync(`${baseDir}/ffmpeg.zip`);
        callback();
    });
    writer.on('error', (err) => {
        prepareFailureMessage("Please check your internet connection and try again.");
    });
}

const executeCommandWithFallbackFunction = (command, callback, failureMessage, fallbackFunction) => {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.log(error);
            fallbackFunction();
            return;
        }
        callback();
    });
}


const checkFFmpegVersion = () => {
    if (fs.existsSync(`${baseDir}/ffmpeg`)) {
        ffmpegPath = `"${baseDir}/ffmpeg/bin/ffmpeg"`;
        fs.writeFileSync(`${baseDir}/ffmpeg_path.txt`, ffmpegPath, 'utf8');
        checkGitRepository();
        return;
    }

    console.log("downloading ffmpeg")

    executeCommandWithFallbackFunction("ffmpeg -version", () => {
        checkGitRepository();
    }, " -- DOWNLOADING FFMPEG --", () => {
        downloadFFmpeg(() => {
            checkFFmpegVersion();
        });
    });
}

const checkGitVersion = () => {
    if (fs.existsSync(`${baseDir}/git`)) {
        const gitFiles = fs.readdirSync(`${baseDir}/git`);
        gitPath = `"${baseDir}/git/bin/git"`;
        fs.writeFileSync(`${baseDir}/git_path.txt`, gitPath, 'utf8');
        checkFFmpegVersion();
        return;
    }

    console.log("downloading git")

    executeCommandWithFallbackFunction("git --version", () => {
        gitPath = "git";
        fs.writeFileSync(`${baseDir}/git_path.txt`, gitPath, 'utf8');
        checkFFmpegVersion();
    }, " -- DOWNLOADING GIT --", () => {
        downloadGit(() => {
            checkGitVersion();
        });
    });
}

const checkNodeVersion = () => {
    if (fs.existsSync(`${baseDir}/node`)) {
        const nodeFiles = fs.readdirSync(`${baseDir}/node`);
        nodePath = `"${baseDir}/node/${nodeFiles[0]}/node"`;
        npmPath = `"${baseDir}/node/${nodeFiles[0]}/npm"`;
        fs.writeFileSync(`${baseDir}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
        return;
    }

    if(getPlatform() === "mac") {
        nodePath = "node";
        npmPath = "npm";
        fs.writeFileSync(`${baseDir}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
        return;
    }

    console.log("downloading nodejs")
    
    executeCommandWithFallbackFunction("node --version", () => {
        nodePath = "node";
        npmPath = "npm";
        fs.writeFileSync(`${baseDir}/node_path.txt`, nodePath, 'utf8');
        checkGitVersion();
    }, " -- DOWNLOADING NODEJS --", () => {
        downloadNodeJs(() => {
            checkNodeVersion();
        });
    });
}


const checkGitRepository = () => {
    if (fs.existsSync(`${baseDir}/streamer`)) {
        startServer();
    } else {
        exec(`${gitPath} clone https://github.com/DevanshSampat/HLS-Video-Streaming.git "${baseDir}/streamer"`, (error, stdout, stderr) => {
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
    if (fs.existsSync(`${baseDir}/path.txt`)) {
        fs.writeFileSync(`${baseDir}/streamer/path.txt`, fs.readFileSync(`${baseDir}/path.txt`, 'utf8'), 'utf8');
        fs.unlinkSync(`${baseDir}/path.txt`);
    }
    executeCommandWithConsoleLogging(`cd "${baseDir}/streamer" && ${gitPath} pull && ${npmPath} install && ${nodePath} server.js`);
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