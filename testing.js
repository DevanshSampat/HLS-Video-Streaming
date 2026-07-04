const { execSync } = require('child_process');
console.log("platform: "+ process.platform);
function getTrueMacArch() {
    try {
        const isTranslated = execSync('sysctl -in sysctl.proc_translated').toString().trim() === '1';
        if (isTranslated) return 'arm64';
        const hasArmCpu = execSync('sysctl -in hw.optional.arm64').toString().trim() === '1';
        if (hasArmCpu) return 'arm64';
    } catch (e) {}

    const arch = execSync('sysctl -n hw.machine').toString().trim();
    if (arch === 'arm64') return 'arm64';
    if (arch === 'x86_64') return 'x64';
    return 'x64';
}
console.log("arch: " + getTrueMacArch());
