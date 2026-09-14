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

/**
 * What a failed probe actually MEANS. This exists because of a real incident.
 *
 * `route -f` flushed this machine's routing table, so NO process could open a loopback
 * socket. Proxima was running and listening on 19222 the whole time. preflight said:
 *
 *     Proxima did not answer on any known port: 19222, 19223. Start Proxima.
 *
 * and the diagnosis went at the application for hours. ping() resolved a bare `false` for
 * every failure, so "nothing is listening" and "this host cannot open a socket at all"
 * produced identical output. The header above already warned that an error naming the
 * wrong cause is worse than a vague one. It was, and it did.
 *
 * ECONNREFUSED is the ONLY code that means what the old message claimed: something
 * answered the SYN and declined it, which is a working TCP stack reporting that nothing
 * is bound to that port. Every other code here is the HOST, and restarting Proxima
 * cannot change any of them.
 */
const FAULT = {
    ECONNREFUSED: { host: false, meaning: 'nothing is listening on this port (the stack answered and declined)' },
    ENETUNREACH: { host: true, meaning: 'no route to 127.0.0.0/8 — the loopback route is missing from the routing table' },
    EHOSTUNREACH: { host: true, meaning: 'loopback is unreachable at the IP layer' },
    EADDRNOTAVAIL: { host: true, meaning: '127.0.0.1 is not a usable local address' },
    EAFNOSUPPORT: { host: true, meaning: 'address family unavailable — the IP stack is not initialised' },
    EACCES: { host: true, meaning: 'blocked by policy — firewall, WFP filter or security software' },
    EPERM: { host: true, meaning: 'blocked by policy — firewall, WFP filter or security software' },
    // Observed in that same incident AFTER the loopback route was restored by hand: the
    // route existed so the SYN left, and nothing ever came back. A packet that vanishes
    // on loopback is being dropped below the routing layer.
    ETIMEDOUT: { host: true, meaning: 'the attempt vanished — packets are being dropped below routing' },
    ETIME: { host: true, meaning: 'the attempt vanished — packets are being dropped below routing' }
};

/** True when a failure is the machine's networking rather than the application. */
function isHostNetworkFault(code) {
    return !!(FAULT[code] && FAULT[code].host);
}

/**
 * Build an error a reader can act on. One of these tells you to start an app, the other
 * tells you to look at the OS — and they used to be the same sentence.
 */
function describeFailure(attempts) {
    const tried = attempts
        .map((a) => a.port + ' (' + a.via + (a.code ? ', ' + a.code : '') + ')')
        .join(', ');
    const hostFaults = attempts.filter((a) => isHostNetworkFault(a.code));

    // Every candidate failing for a host reason means the fault cannot be per-port, and
    // therefore cannot be about which application happens to be running.
    if (attempts.length > 0 && hostFaults.length === attempts.length) {
        const code = hostFaults[0].code;
        const e = new Error(
            'THIS MACHINE cannot open a loopback socket — ' +
            ((FAULT[code] || {}).meaning || 'the host refused the socket') + ' (' + code + ').' +
            '\nProxima is almost certainly fine. Do NOT restart it; check the host first:' +
            '\n  ping 127.0.0.1                     expect a reply, not "General failure"' +
            '\n  netsh interface ipv4 show route    expect 127.0.0.0/8 on the loopback interface' +
            '\nA table flushed by `route -f` looks exactly like this, and a reboot restores it.' +
            '\nPorts tried: ' + tried);
        e.hostNetworkFault = true;
        e.code = code;
        e.attempts = attempts;
        return e;
    }

    const e = new Error('Proxima did not answer on any known port: ' + tried +
        '. Start Proxima, or pass --port.');
    e.hostNetworkFault = false;
    e.attempts = attempts;
    return e;
}

/**
 * Probe one port. Resolves { ok, code } — never rejects. The `code` is what lets a caller
 * tell a dead application from a dead network.
 */
function ping(port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = net.createConnection(port, '127.0.0.1');
        let buf = '';
        let done = false;
        const finish = (ok, code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) { /* ignore */ }
            resolve({ ok: ok, code: code || null });
        };
        const timer = setTimeout(() => finish(false, 'ETIMEDOUT'), timeoutMs || 2500);
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
                const pong = !!(j && j.success === true && j.message === 'pong');
                // Something IS listening and talking, it just is not Proxima. That is a
                // different fact from silence and should not read as a host fault.
                finish(pong, pong ? null : 'NOTPROXIMA');
            } catch (e) { finish(false, 'NOTPROXIMA'); }
        });
        sock.on('error', (e) => finish(false, (e && e.code) || 'EUNKNOWN'));
    });
}

/**
 * Find the port Proxima is actually on. Resolves { port, via, tried } or throws an error
 * listing every candidate, so the message says what was attempted instead of naming one
 * port as though it were the only possibility.
 */
async function discover(explicit, timeoutMs) {
    const list = candidates(explicit);
    const attempts = [];
    for (const c of list) {
        const r = await ping(c.port, timeoutMs);
        if (r.ok) return { port: c.port, via: c.via, tried: list };
        // Keep WHY each one failed. Discarding the code is precisely what turned a dead
        // loopback stack into "Start Proxima".
        attempts.push({ port: c.port, via: c.via, code: r.code });
    }
    const err = describeFailure(attempts);
    err.tried = list;
    throw err;
}

module.exports = {
    DEFAULT_PORT, discover, ping, candidates,
    resolvePortSync, recordedPort, settingsPort, userDataDir,
    isHostNetworkFault, describeFailure
};
