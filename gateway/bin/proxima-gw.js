#!/usr/bin/env node
'use strict';

/**
 * proxima-gw - the gateway control CLI.
 *
 * Plain commands, one action, exit. Deliberately not a REPL: the interactive
 * consumer of this gateway is the automation client, and a human uses this a couple of
 * times a month. A prompt-driven interface would earn nothing.
 *
 * Works from PowerShell, cmd, bash, or any shell. Output is plain lines, no colour
 * codes, no cursor tricks, so it pipes cleanly.
 *
 *   proxima-gw check
 *   proxima-gw status
 *   proxima-gw login claude --cookies .\claude.json
 *   proxima-gw login claude --headed
 *   proxima-gw logout perplexity
 *
 * Port discovery mirrors the automation client exactly: AGENT_HUB_PORT, then
 * PROXIMA_IPC_PORT, then the recorded ipc-port.json, then 19222. If the client can
 * find the gateway, so can this.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const { StateStore, DEFAULT_PORT } = require('../src/state-store');
const { PROVIDERS, PROVIDER_NAMES } = require('../src/providers');

const EXIT = { OK: 0, ERROR: 1, USAGE: 2 };

// ---- output -------------------------------------------------------------------
// Plain, uncoloured lines. PowerShell's output redirection and any pipe downstream
// should not have to strip escape codes.

const say = (s = '') => process.stdout.write(`${s}\n`);
const fail = (s) => process.stderr.write(`${s}\n`);

function usage() {
    return [
        'proxima-gw - control the Proxima provider gateway',
        '',
        'USAGE',
        '  proxima-gw check                          is the gateway running?',
        '  proxima-gw status                         per-provider state',
        '  proxima-gw login <provider> --cookies <file>',
        '  proxima-gw login <provider> --headed      open a real window and log in by hand',
        '  proxima-gw logout <provider>              destroy that provider auth on disk',
        '',
        `PROVIDERS  ${PROVIDER_NAMES.join(', ')}`,
        '',
        'ENVIRONMENT',
        '  AGENT_HUB_PORT            port to dial (overrides the recorded fact)',
        '  PROXIMA_GATEWAY_STATE_DIR where profiles and cookie backups live',
        '  PROXIMA_GATEWAY_PORT=1    allow the gateway to relocate to port+1',
        '',
        'EXAMPLES (PowerShell)',
        '  node bin\\proxima-gw.js status',
        '  node bin\\proxima-gw.js login claude --cookies .\\cookies\\claude.json',
        '  node bin\\proxima-gw.js login chatgpt --headed',
        '  Get-Content .\\cookies\\claude.json -Raw | node bin\\proxima-gw.js login claude --stdin',
    ].join('\n');
}

// ---- argument parsing --------------------------------------------------------

function parseArgs(argv) {
    const out = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                out.flags[key] = next;
                i += 1;
            } else {
                out.flags[key] = true;
            }
        } else {
            out._.push(a);
        }
    }
    return out;
}

// ---- connection --------------------------------------------------------------

function resolvePort() {
    const explicit = Number(process.env.AGENT_HUB_PORT) || Number(process.env.PROXIMA_IPC_PORT);
    if (explicit) return { port: explicit, via: 'env' };

    const fact = new StateStore().readPortFact();
    if (fact && pidAlive(fact.pid)) return { port: fact.port, via: fact.file || 'ipc-port.json' };

    return { port: DEFAULT_PORT, via: 'default (no recorded fact found)' };
}

function pidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

/** One request, one response, one socket. */
function call(action, provider, data = {}, timeoutMs = 30000) {
    const { port, via } = resolvePort();
    return new Promise((resolve) => {
        const socket = net.createConnection({ port, host: '127.0.0.1' });
        let buffer = '';
        let settled = false;

        const done = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };

        const timer = setTimeout(() => {
            done({ ok: false, error: `Timed out after ${timeoutMs}ms talking to port ${port}` });
        }, timeoutMs);
        if (timer.unref) timer.unref();

        socket.on('error', (e) => {
            const detail =
                e.code === 'ECONNREFUSED'
                    ? `Nothing is listening on 127.0.0.1:${port} (${via}). Start it with: node src\\index.js`
                    : e.message;
            done({ ok: false, error: detail, code: e.code });
        });

        socket.on('connect', () => {
            socket.write(JSON.stringify({ requestId: 1, action, provider, data }) + '\n');
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.requestId === 1) done({ ok: msg.success === true, response: msg, raw: line });
                } catch {
                    /* skip an unparseable line */
                }
            }
        });
    });
}

// ---- formatting --------------------------------------------------------------

function table(rows, headers) {
    if (rows.length === 0) return '  (none)';
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))
    );
    const line = (cells) => `  ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')}`;
    return [line(headers), `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`, ...rows.map(line)].join('\n');
}

// ---- commands ----------------------------------------------------------------

async function cmdCheck() {
    const { port, via } = resolvePort();
    const res = await call('ping', null, {}, 4000);
    if (res.ok) {
        say(`gateway  RUNNING  on 127.0.0.1:${port}  (port from ${via})`);
        return EXIT.OK;
    }
    say(`gateway  NOT RUNNING  on 127.0.0.1:${port}  (port from ${via})`);
    say(`  ${res.error}`);
    say('');
    say('Start it with:');
    say('  node src\\index.js');
    return EXIT.ERROR;
}

async function cmdStatus() {
    const health = await call('ping', null, {}, 4000);
    if (!health.ok) {
        fail(`Gateway not reachable: ${health.error}`);
        fail('Start it with: node src\\index.js');
        return EXIT.ERROR;
    }
    const res = await call('getStatus');
    if (!res.ok) {
        fail(res.response.error || 'status failed');
        return EXIT.ERROR;
    }
    const st = res.response;
    say(`gateway  running  pid ${st.pid}  port ${st.port}  since ${st.startedAt}`);
    say('');
    const rows = [];
    for (const name of st.knownProviders || PROVIDER_NAMES) {
        const auth = await call('isLoggedIn', name);
        rows.push([
            name,
            (st.providers || []).includes(name) ? 'loaded' : '-',
            auth.ok ? (auth.response.loggedIn ? 'yes' : 'NO') : '?',
        ]);
    }
    say(table(rows, ['PROVIDER', 'STATE', 'LOGGED IN']));
    if ((st.providers || []).length === 0) {
        say('');
        say('  No provider is loaded. Start one with: proxima-gw login <provider> --headed');
    }
    return EXIT.OK;
}

async function cmdLogin(provider, flags) {
    if (!PROVIDERS[provider]) {
        fail(`Unknown provider "${provider}". Known: ${PROVIDER_NAMES.join(', ')}`);
        return EXIT.USAGE;
    }

    if (flags.headed) {
        // Flip just this provider to a visible Chromium window, load it, and leave it
        // open. The operator logs in by hand; the profile is flushed on unload or
        // shutdown, and the window is disposable.
        say(`Opening a visible window for ${provider}.`);
        say('Log in in that window, then close it - the session is saved to the profile.');
        say('');
        const set = await call('setSetting', null, {
            key: 'headlessByProvider',
            value: { [provider]: false },
        });
        if (!set.ok) {
            fail(set.response.error || 'could not set headless override');
            return EXIT.ERROR;
        }
        const init = await call('initProvider', provider, {}, 90000);
        if (!init.ok) {
            fail(init.response.error || 'could not open the provider');
            return EXIT.ERROR;
        }
        say(`${provider} is open. This setting is restart-requiring;`);
        say('to go back to headless: proxima-gw headless ' + provider);
        return EXIT.OK;
    }

    let cookies;
    if (flags.stdin) {
        // PowerShell: Get-Content file -Raw | proxima-gw login claude --stdin
        const chunks = [];
        for await (const c of process.stdin) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
            fail('No cookie JSON arrived on stdin.');
            return EXIT.USAGE;
        }
        try {
            cookies = JSON.parse(raw);
        } catch (e) {
            fail(`Cookie JSON on stdin is not valid: ${e.message}`);
            return EXIT.USAGE;
        }
    } else if (typeof flags.cookies === 'string') {
        const file = path.resolve(flags.cookies);
        if (!fs.existsSync(file)) {
            fail(`No such file: ${file}`);
            return EXIT.USAGE;
        }
        try {
            cookies = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            fail(`${file} is not valid JSON: ${e.message}`);
            return EXIT.USAGE;
        }
    } else {
        fail('Provide --cookies <file> or --headed.');
        say('');
        say('  proxima-gw login claude --cookies .\\cookies\\claude.json');
        say('  proxima-gw login claude --headed');
        return EXIT.USAGE;
    }

    const res = await call('setCookies', provider, { cookies }, 60000);
    if (!res.ok) {
        fail(res.response.error || 'login failed');
        return EXIT.ERROR;
    }
    const r = res.response;
    say(`${provider}: ${r.message}`);
    if (r.failed > 0) say(`  ${r.failed} cookie(s) were rejected by the browser.`);
    if (!r.loggedIn) {
        say('');
        say('  The cookies were applied but none are recognised auth cookies for this');
        say('  provider. Export again from the provider origin, or use --headed.');
        return EXIT.ERROR;
    }
    return EXIT.OK;
}

async function cmdLogout(provider) {
    if (!PROVIDERS[provider]) {
        fail(`Unknown provider "${provider}". Known: ${PROVIDER_NAMES.join(', ')}`);
        return EXIT.USAGE;
    }
    const res = await call('purgeProvider', provider);
    if (!res.ok) {
        fail(res.response.error || 'logout failed');
        return EXIT.ERROR;
    }
    say(`${provider}: auth destroyed on disk. Next use needs a fresh login.`);
    return EXIT.OK;
}

async function cmdHeadless(provider) {
    if (!PROVIDERS[provider]) {
        fail(`Unknown provider "${provider}". Known: ${PROVIDER_NAMES.join(', ')}`);
        return EXIT.USAGE;
    }
    const res = await call('setSetting', null, {
        key: 'headlessByProvider',
        value: { [provider]: true },
    });
    if (!res.ok) {
        fail(res.response.error || 'could not update the setting');
        return EXIT.ERROR;
    }
    say(`${provider}: headless. Restart the gateway to apply.`);
    return EXIT.OK;
}

// ---- entry -------------------------------------------------------------------

async function main(argv) {
    const args = parseArgs(argv);
    const cmd = args._[0];

    if (!cmd || args.flags.help || cmd === 'help') {
        say(usage());
        return cmd ? EXIT.OK : EXIT.USAGE;
    }

    switch (cmd) {
        case 'check':
            return cmdCheck();
        case 'status':
            return cmdStatus();
        case 'login':
            return cmdLogin(args._[1], args.flags);
        case 'logout':
            return cmdLogout(args._[1]);
        case 'headless':
            return cmdHeadless(args._[1]);
        default:
            fail(`Unknown command "${cmd}".`);
            say('');
            say(usage());
            return EXIT.USAGE;
    }
}

if (require.main === module) {
    main(process.argv.slice(2))
        .then((code) => process.exit(code))
        .catch((e) => {
            fail(`proxima-gw: ${e && e.message ? e.message : e}`);
            process.exit(EXIT.ERROR);
        });
}

module.exports = { main, parseArgs, resolvePort, call, table, usage, EXIT };
