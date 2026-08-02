// Proxima — Pre-build Wheel Script.
// Packages proxima-agent as a .whl before electron-builder bundles the app.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const AGENT_DIR = path.join(__dirname, '..', 'proxima-agent');
const WHEEL_DIR = path.join(__dirname, '..', 'build', 'wheels');

if (fs.existsSync(WHEEL_DIR)) {
    for (const f of fs.readdirSync(WHEEL_DIR)) {
        if (f.endsWith('.whl')) fs.unlinkSync(path.join(WHEEL_DIR, f));
    }
} else {
    fs.mkdirSync(WHEEL_DIR, { recursive: true });
}

console.log('[build-wheel] Building proxima-agent wheel...');

const candidates = process.platform === 'win32'
    ? [['py', ['-3', '-m', 'pip']], ['python', ['-m', 'pip']], ['python3', ['-m', 'pip']]]
    : [['python3', ['-m', 'pip']], ['python', ['-m', 'pip']]];

let built = false;
for (const [cmd, args] of candidates) {
    try {
        execSync(`${cmd} ${args.join(' ')} wheel --no-deps -w "${WHEEL_DIR}" "${AGENT_DIR}"`, {
            stdio: 'inherit',
            timeout: 120000,
        });
        built = true;
        break;
    } catch {
        continue;
    }
}

if (!built) {
    console.error('[build-wheel] Failed to build wheel: no working Python found.');
    console.error('[build-wheel] Continuing without wheel — runtime will fall back to source install.');
    process.exit(0);
}

const wheels = fs.readdirSync(WHEEL_DIR).filter(f => f.endsWith('.whl'));
if (wheels.length > 0) {
    console.log(`[build-wheel] Success: ${wheels.join(', ')}`);
} else {
    console.log('[build-wheel] Warning: No .whl file produced.');
}
