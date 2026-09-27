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
const FALLBACK_ATTEMPTS = 1; // try port, then port+1, then give up (F2)

function defaultStateDir() {
    const override = process.env.PROXIMA_GATEWAY_STATE_DIR;
    if (override) return override;
    return path.join(os.homedir(), '.proxima-gateway');
}

class StateStore {
    constructor(dir = defaultStateDir()) {
        this.dir = dir;
        this.settingsPath = path.join(dir, 'settings.json');
        this.portFactPath = path.join(dir, 'ipc-port.json');
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
     * Read the port the running process actually bound.
     * Returns null when no process has recorded a fact (or the recorded pid is gone).
     */
    readPortFact() {
        try {
            const fact = JSON.parse(fs.readFileSync(this.portFactPath, 'utf8'));
            if (!fact || typeof fact.port !== 'number') return null;
            return fact;
        } catch {
            return null;
        }
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
        fs.writeFileSync(this.portFactPath, JSON.stringify(fact, null, 2), 'utf8');
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
        try {
            fs.unlinkSync(this.portFactPath);
        } catch {
            /* already gone */
        }
    }

    profileDir(provider) {
        return path.join(this.profilesDir, provider);
    }
}

module.exports = { StateStore, DEFAULT_PORT, FALLBACK_ATTEMPTS, defaultStateDir };
