const { exec } = require('child_process');
const fs = require('fs');

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


const checkTailscaleVersion = () => {
    executeCommand("tailscale --version", () => {
        console.log("Tailscale is installed.");
        checkGitRepository();
    }, "Tailscale is not installed or not added to PATH. Please install Tailscale from https://tailscale.com/download and try again.");
}

const checkFFmpegVersion = () => {
    executeCommand("ffmpeg -version", () => {
        console.log("FFmpeg is installed.");
        checkTailscaleVersion();
    }, "FFmpeg is not installed or not added to PATH. Please install FFmpeg from  powershell by typing \"winget install ffmpeg\" and try again.");
}

const checkGitVersion = () => {
    executeCommand("git --version", () => {
        console.log("Git is installed.");
        checkFFmpegVersion();
    }, "Git is not installed or not added to PATH. Please install Git from https://git-scm.com/downloads and try again.");
}

const checkNodeVersion = () => {
    executeCommand("node --version", () => {
        console.log("Node.js is installed.");
        checkGitVersion();
    }, "Node.js is not installed or not added to PATH. Please install Node.js from https://nodejs.org/en/download and try again.");
}


const checkGitRepository = () => {
    if (fs.existsSync(`${__dirname}/streamer`)) {
        startServer();
    } else {
        exec(`git clone https://github.com/DevanshSampat/HLS-Video-Streaming.git "${__dirname}/streamer"`, (error, stdout, stderr) => {
            if (error) {
                prepareFailureMessage("Failed to clone the Git repository.");
            } else {
                startServer();
            }
        });
    }
}

const startServer = () => {
    if (fs.existsSync(`${__dirname}/path.txt`)) {
        fs.writeFileSync(`${__dirname}/streamer/path.txt`, fs.readFileSync(`${__dirname}/path.txt`, 'utf8'), 'utf8');
        fs.unlinkSync(`${__dirname}/path.txt`);
        console.log("Starting server...");
        exec(`cd "${__dirname}/streamer" && npm run start`);
    } else {
        console.log("Starting server, pick a video folder when prompted...");
        exec(`cd "${__dirname}/streamer" && npm run start`);
    }
}

checkNodeVersion();