/**
 * Named Chrome instances, so two agents on one laptop do not fight over one browser.
 *
 * The old setup had exactly one: port 9333, profile %TEMP%\qa-chrome-profile, and
 * start-browser reported `reused: true` when something was already there. That is not a
 * shared browser by design, it is a collision by default — measured on this machine,
 * port 9333 held eight page targets belonging to a different project.
 *
 * The mechanism that makes isolation work is the PROFILE, not the port. Chrome treats
 * --user-data-dir as the identity of a browser: launch a second Chrome with the same
 * profile and it does not start a new browser, it hands the command line to the running
 * one and exits. So a per-instance port with a shared profile would still give you one
 * browser. Both have to differ, which is what this registry guarantees.
 *
 * Registry entries live in %TEMP%\qa-chrome-instances\<name>.json and record the port,
 * profile, pid and start time. They are advisory: a stale entry whose process is gone is
 * detected and replaced rather than trusted.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const REG_DIR = path.join(os.tmpdir(), 'qa-chrome-instances');
const PROFILE_ROOT = path.join(os.tmpdir(), 'qa-chrome-profiles');
const BASE_PORT = 9333;

function safeName(name) {
    const s = String(name || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    if (!s) throw new Error('instance name must contain at least one usable character');
    return s;
}

function entryPath(name) { return path.join(REG_DIR, safeName(name) + '.json'); }
function profileFor(name) { return path.join(PROFILE_ROOT, safeName(name)); }

function readEntry(name) {
    try {
        const f = entryPath(name);
        if (!fs.existsSync(f)) return null;
        return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { return null; }
}

function writeEntry(entry) {
    fs.mkdirSync(REG_DIR, { recursive: true });
    fs.writeFileSync(entryPath(entry.name), JSON.stringify(entry, null, 2));
    return entry;
}

function removeEntry(name) {
    try { fs.unlinkSync(entryPath(name)); return true; } catch (e) { return false; }
}

function listEntries() {
    try {
        return fs.readdirSync(REG_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(REG_DIR, f), 'utf8')); } catch (e) { return null; } })
            .filter(Boolean);
    } catch (e) { return []; }
}

/** Is this pid still alive? Used to spot registry entries left by a crashed browser. */
function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

/** Is anything listening here? A free port is one nobody answers on. */
function portFree(port) {
    return new Promise((resolve) => {
        const sock = net.createConnection({ port: port, host: '127.0.0.1' });
        let settled = false;
        const done = (free) => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { } resolve(free); };
        sock.on('connect', () => done(false));
        sock.on('error', () => done(true));
        setTimeout(() => done(true), 800);
    });
}

/**
 * A port nobody is on, skipping any this registry has already handed out — otherwise two
 * instances started in the same second can race onto the same number, and the second
 * Chrome silently binds [::1] instead while the first holds 127.0.0.1.
 */
async function allocatePort(startAt) {
    const taken = new Set(listEntries().map((e) => e.port));
    let port = startAt || BASE_PORT;
    for (let i = 0; i < 60; i++, port++) {
        if (taken.has(port)) continue;
        if (await portFree(port)) return port;
    }
    throw new Error('no free debug port found in ' + (startAt || BASE_PORT) + '..' + port);
}

/** Kill one instance's browser, by pid, and drop its registry entry. */
function killInstance(name) {
    const e = readEntry(name);
    if (!e) return { ok: false, error: 'no instance named ' + safeName(name) };
    let killed = false;
    if (e.pid && pidAlive(e.pid)) {
        if (process.platform === 'win32') {
            // /T because Chrome is a process tree; killing the launcher alone leaves the
            // renderers holding the port.
            spawnSync('taskkill', ['/PID', String(e.pid), '/T', '/F'], { encoding: 'utf8' });
        } else {
            try { process.kill(e.pid, 'SIGTERM'); } catch (err) { /* already gone */ }
        }
        killed = true;
    }
    removeEntry(name);
    return { ok: true, name: safeName(name), pid: e.pid, port: e.port, killed: killed };
}

module.exports = {
    REG_DIR, PROFILE_ROOT, BASE_PORT,
    safeName, entryPath, profileFor,
    readEntry, writeEntry, removeEntry, listEntries,
    pidAlive, portFree, allocatePort, killInstance
};
