/**
 * One place that knows how to find Proxima's IPC port.
 *
 * There were three conventions before this: the MCP server read AGENT_HUB_PORT, the QA
 * reviewer read PROXIMA_IPC_PORT and settings.json, and preflight hardcoded 19222. So a
 * Proxima that had fallen back to 19223 was invisible to preflight, which reported
 * "not reachable — start Proxima" about an app that was running fine. An error message
 * that names the wrong cause is worse than a vague one; it sends you to restart something
 * that did not need restarting.
 *
 * The fallback is real, not hypothetical: main-v2 retries on DEFAULT_IPC_PORT + 1 when
 * 19222 is taken, which happens whenever a second Proxima (or a leftover process) holds
 * it. Worse, only the PRIMARY listen path used to write settings.ipcPort, so after a
 * fallback the settings file confidently reported a port nothing was listening on.
 *
 * Resolution order, most-specific first:
 *   1. an explicit argument (a --port flag)
 *   2. AGENT_HUB_PORT, then PROXIMA_IPC_PORT   (both honoured; neither wins by accident)
 *   3. ipc-port.json — written by the app with the port it ACTUALLY bound
 *   4. settings.json ipcPort — the user's preference, which may be stale
 *   5. 19222, then 19223 — the default and its fallback
 *
 * `discover()` then proves a candidate rather than assuming it: it sends a real `ping` and
 * waits for `pong`. Something else listening on 19223 must not be mistaken for Proxima.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 19222;

/** Proxima's userData directory, without depending on electron. */
function userDataDir() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'proxima');
    }
    if (process.platform === 'darwin' && process.env.HOME) {
        return path.join(process.env.HOME, 'Library', 'Application Support', 'proxima');
    }
    return path.join(process.env.HOME || '.', '.config', 'proxima');
}

function readJson(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { return null; }
}

/** The port the running app recorded for itself, or null. */
function recordedPort() {
    const j = readJson(path.join(userDataDir(), 'ipc-port.json'));
    return j && Number(j.port) ? Number(j.port) : null;
}

/** The port in settings — a preference, and stale after a fallback. */
function settingsPort() {
    const j = readJson(path.join(userDataDir(), 'settings.json'));
    return j && Number(j.ipcPort) ? Number(j.ipcPort) : null;
}

/** Ordered, de-duplicated candidates with a note on where each came from. */
function candidates(explicit) {
    const out = [];
    const add = (port, via) => {
        const n = Number(port);
        if (!n || out.some((c) => c.port === n)) return;
        out.push({ port: n, via: via });
    };
    add(explicit, 'explicit');
    add(process.env.AGENT_HUB_PORT, 'AGENT_HUB_PORT');
    add(process.env.PROXIMA_IPC_PORT, 'PROXIMA_IPC_PORT');
    add(recordedPort(), 'ipc-port.json');
    add(settingsPort(), 'settings.json');
    add(DEFAULT_PORT, 'default');
    add(DEFAULT_PORT + 1, 'fallback');
    return out;
}

/** Best guess without touching the network. For callers that cannot be async. */
function resolvePortSync(explicit) {
    return candidates(explicit)[0].port;
}

/** Does Proxima answer on this port? Resolves true/false, never rejects. */
function ping(port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = net.createConnection(port, '127.0.0.1');
        let buf = '';
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) { /* ignore */ }
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs || 2500);
        sock.on('connect', () => {
            sock.write(JSON.stringify({ requestId: 'port-probe', action: 'ping' }) + '\n');
        });
        sock.on('data', (d) => {
            buf += d.toString();
            const i = buf.indexOf('\n');
            if (i === -1) return;
            // A real Proxima answers {success:true,message:'pong'}. Anything else on this
            // port is some other program, and treating it as Proxima would produce a much
            // more confusing failure later.
            try {
                const j = JSON.parse(buf.slice(0, i));
                finish(j && j.success === true && j.message === 'pong');
            } catch (e) { finish(false); }
        });
        sock.on('error', () => finish(false));
    });
}

/**
 * Find the port Proxima is actually on. Resolves { port, via, tried } or throws an error
 * listing every candidate, so the message says what was attempted instead of naming one
 * port as though it were the only possibility.
 */
async function discover(explicit, timeoutMs) {
    const list = candidates(explicit);
    for (const c of list) {
        if (await ping(c.port, timeoutMs)) {
            return { port: c.port, via: c.via, tried: list };
        }
    }
    const err = new Error('Proxima did not answer on any known port: ' +
        list.map((c) => c.port + ' (' + c.via + ')').join(', '));
    err.tried = list;
    throw err;
}

module.exports = {
    DEFAULT_PORT, discover, ping, candidates,
    resolvePortSync, recordedPort, settingsPort, userDataDir
};
