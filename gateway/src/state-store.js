'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Settings and the port fact file.
 *
 * Two files, deliberately, because conflating them caused a real failure:
 *
 *   settings.json  a PREFERENCE the operator may have typed. Can be stale. Can be wrong.
 *   ipc-port.json  a FACT about the running process. Written only after a successful bind.
 *
 * Tools that need to reach the gateway must read the fact. A client that trusts the
 * preference will report "gateway is not running" about a process that is running fine
 * on a fallback port.
 */

const DEFAULT_PORT = 19222;
// How far the gateway MAY move if relocation is explicitly enabled. Zero would make
// the allowRelocate option a lie: the flag would exist and do nothing.
const FALLBACK_ATTEMPTS = 1;

/**
 * The legacy Electron app's userData directory.
 *
 * Duplicated from scripts/lib/proxima-port.cjs rather than imported, because that file
 * lives in the automation client and this module must not depend on it. The paths MUST
 * stay identical: this is where the existing client looks for ipc-port.json, so it is
 * the only place the gateway's port can be discovered by the tooling that is supposed
 * to talk to it.
 */
function legacyUserDataDir() {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'proxima');
    }
    if (process.platform === 'darwin' && process.env.HOME) {
        return path.join(process.env.HOME, 'Library', 'Application Support', 'proxima');
    }
    return path.join(process.env.HOME || '.', '.config', 'proxima');
}

function defaultStateDir() {
    const override = process.env.PROXIMA_GATEWAY_STATE_DIR;
    if (override) return override;
    return path.join(os.homedir(), '.proxima-gateway');
}

class StateStore {
    constructor(dir = defaultStateDir()) {
        this.dir = dir;
        this.settingsPath = path.join(dir, 'settings.json');
        this.profilesDir = path.join(dir, 'profiles');
        this.cookieBackupDir = path.join(dir, 'cookie-backups');
        this._ensureDirs();
    }

    _ensureDirs() {
        for (const d of [this.dir, this.profilesDir, this.cookieBackupDir]) {
            fs.mkdirSync(d, { recursive: true });
        }
    }

    // ---- settings (preference) ----

    loadSettings() {
        try {
            const raw = fs.readFileSync(this.settingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            // A missing or corrupt settings file is not fatal. Defaults apply.
            return {};
        }
    }

    saveSettings(patch) {
        const next = { ...this.loadSettings(), ...patch };
        fs.writeFileSync(this.settingsPath, JSON.stringify(next, null, 2), 'utf8');
        return next;
    }

    // ---- port fact ----

    /**
     * Where the port fact is WRITTEN.
     *
     * The legacy app's userData dir, not this gateway's own state dir. The existing
     * automation client reads ipc-port.json from exactly this path, so a fact written
     * anywhere else is invisible to it - the client would report "Proxima is not
     * running" against a healthy gateway. Profiles and cookies stay private to the
     * gateway's state dir; only the port is a shared fact.
     */
    get portFactPath() {
        const override = process.env.PROXIMA_GATEWAY_PORT_FACT;
        if (override) return override;
        return path.join(legacyUserDataDir(), 'ipc-port.json');
    }

    /**
     * Read the port the running process actually bound.
     * Returns null when no process has recorded a fact (or the recorded pid is gone).
     */
    readPortFact() {
        for (const file of this.portFactPaths()) {
            try {
                const fact = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!fact || typeof fact.port !== 'number') continue;
                return { ...fact, file };
            } catch {
                /* try the next location */
            }
        }
        return null;
    }

    /** Both locations, own state dir first so the gateway is self-sufficient. */
    portFactPaths() {
        const own = path.join(this.dir, 'ipc-port.json');
        const legacy = this.portFactPath;
        return own === legacy ? [own] : [own, legacy];
    }

    /**
     * The port a client should dial. The FACT always beats the PREFERENCE (F3).
     * A fact naming a dead pid is ignored.
     */
    resolvePort() {
        const fact = this.readPortFact();
        if (fact && this._pidAlive(fact.pid)) {
            return { port: fact.port, source: 'fact', pid: fact.pid };
        }
        const pref = this.loadSettings().ipcPort;
        if (typeof pref === 'number' && pref > 0) {
            return { port: pref, source: 'preference', pid: fact ? fact.pid : null };
        }
        return { port: DEFAULT_PORT, source: 'default', pid: null };
    }

    _pidAlive(pid) {
        if (!pid || typeof pid !== 'number') return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            // EPERM means it exists but belongs to someone else - still alive.
            return e.code === 'EPERM';
        }
    }

    /** Written only after a successful bind. */
    recordPortFact(port, extra = {}) {
        const fact = {
            port,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            ...extra,
        };
        const body = JSON.stringify(fact, null, 2);

        // Written to BOTH locations. The legacy location is what makes the existing
        // automation client able to find this process at all.
        for (const file of this.portFactPaths()) {
            try {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, body, 'utf8');
            } catch {
                /* one location failing must not stop the other */
            }
        }

        // Keep the preference in sync so it is not misleading next time, but the fact
        // remains the authority.
        try {
            this.saveSettings({ ipcPort: port });
        } catch {
            /* preference sync is best-effort */
        }
        return fact;
    }

    clearPortFact() {
        for (const file of this.portFactPaths()) {
            try {
                fs.unlinkSync(file);
            } catch {
                /* already gone */
            }
        }
    }

    profileDir(provider) {
        return path.join(this.profilesDir, provider);
    }
}

module.exports = {
    StateStore,
    DEFAULT_PORT,
    FALLBACK_ATTEMPTS,
    defaultStateDir,
    legacyUserDataDir,
};
