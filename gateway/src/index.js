'use strict';

const { StateStore, DEFAULT_PORT } = require('./state-store');
const { CookieStore } = require('./cookie-store');
const { EngineLoader } = require('./engine-loader');
const { SessionManager } = require('./session-manager');
const { IpcServer } = require('./ipc-server');
const { createHandler } = require('./actions');

/**
 * Gateway entrypoint.
 *
 * Owns the lifecycle: state directory, cookie store, engine loader, session manager,
 * IPC server. Shutdown flushes cookies and clears the port fact so the next client
 * never dials a dead port.
 */

async function startGateway({ port = DEFAULT_PORT, host = '127.0.0.1', stateDir } = {}) {
    const stateStore = new StateStore(stateDir);
    const settings = stateStore.loadSettings();
    const cookieStore = new CookieStore(stateStore);
    const engineLoader = new EngineLoader({ stateStore });
    const sessions = new SessionManager({
        stateStore,
        cookieStore,
        engineLoader,
        settings,
    });

    const startedAt = new Date().toISOString();
    const fileReferenceEnabled = () => stateStore.loadSettings().fileReference !== false;

    const handler = createHandler({ sessions, stateStore, startedAt, getFileReferenceEnabled: fileReferenceEnabled });
    const ipc = new IpcServer({ handler, stateStore, port, host });

    const boundPort = await ipc.listen();

    let shuttingDown = false;
    async function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            await sessions.flushAll();
            await sessions.close();
        } finally {
            await ipc.close();
        }
    }

    return { stateStore, cookieStore, engineLoader, sessions, ipc, handler, boundPort, shutdown };
}

async function main() {
    const port = Number(process.env.AGENT_HUB_PORT) || DEFAULT_PORT;
    const gateway = await startGateway({ port });

    process.stdout.write(
        `[gateway] listening on 127.0.0.1:${gateway.boundPort}\n` +
            `[gateway] state dir: ${gateway.stateStore.dir}\n` +
            `[gateway] headless: ${gateway.stateStore.loadSettings().headless !== false}\n`
    );

    const stop = async (signal) => {
        process.stdout.write(`\n[gateway] ${signal} - shutting down\n`);
        await gateway.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('uncaughtException', async (e) => {
        process.stderr.write(`[gateway] uncaught: ${e && e.stack}\n`);
        await gateway.shutdown();
        process.exit(1);
    });
}

if (require.main === module) {
    main().catch((e) => {
        process.stderr.write(`[gateway] failed to start: ${e && e.stack}\n`);
        process.exit(1);
    });
}

module.exports = { startGateway, main };
