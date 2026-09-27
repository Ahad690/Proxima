'use strict';

const { StateStore, DEFAULT_PORT } = require('./state-store');
const { CookieStore } = require('./cookie-store');
const { EngineLoader } = require('./engine-loader');
const { SessionManager } = require('./session-manager');
const { IpcServer } = require('./ipc-server');
const { createHandler } = require('./actions');
const { log } = require('./logger');

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
    // Relocating is opt-in. By default a taken port is an error, because silently
    // moving leaves a port fact that can point a client at the other process.
    const allowRelocate = /^(1|true|yes)$/i.test(String(process.env.PROXIMA_GATEWAY_PORT || ''));
    const ipc = new IpcServer({ handler, stateStore, port, host });

    const boundPort = await ipc.listen({ allowRelocate });

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

    log.info(
        `listening on 127.0.0.1:${gateway.boundPort} ` +
            `state=${gateway.stateStore.dir} ` +
            `headless=${gateway.stateStore.loadSettings().headless !== false}`
    );

    const stop = async (signal) => {
        log.info(`${signal} received, shutting down`);
        await gateway.shutdown();
        process.exit(0);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('uncaughtException', async (e) => {
        // Via the logger, so a stack quoting a token-bearing URL is redacted.
        log.exception(e, { phase: 'uncaughtException' });
        await gateway.shutdown();
        process.exit(1);
    });
}

if (require.main === module) {
    main().catch((e) => {
        log.exception(e, { phase: 'startup' });
        process.exit(1);
    });
}

module.exports = { startGateway, main };
