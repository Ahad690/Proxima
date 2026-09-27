'use strict';

const net = require('net');
const { DEFAULT_PORT, FALLBACK_ATTEMPTS } = require('./state-store');
const { toSafeError } = require('./logger');
const { log } = require('./logger');
const { redactString, redact } = require('./redact');

/**
 * Loopback IPC server.
 *
 * Transport: TCP on 127.0.0.1, newline-delimited JSON. One request object per line,
 * one response object per line. The framing is deliberately trivial so an existing
 * client needs no change.
 */

const MAX_LINE_BYTES = 8 * 1024 * 1024; // guard against an unbounded buffer (F5-adjacent)

/**
 * Best-effort requestId recovery from an unparseable frame.
 * Keeps a malformed request correlatable instead of leaving the caller pending forever.
 */
function salvageRequestId(line) {
    const m = /"requestId"\s*:\s*(-?\d+)/.exec(line);
    return m ? Number(m[1]) : null;
}

class FrameDecoder {
    constructor(maxLineBytes = MAX_LINE_BYTES) {
        this.buffer = '';
        this.maxLineBytes = maxLineBytes;
        this.dropped = 0;
    }

    /**
     * Feed raw chunks, get back complete lines.
     * A partial trailing line is retained until its newline arrives.
     */
    push(chunk) {
        this.buffer += chunk;
        if (this.buffer.length > this.maxLineBytes) {
            // Something is wrong with the peer. Drop what we have rather than grow
            // without bound, and count it so the condition is observable.
            this.dropped += 1;
            this.buffer = '';
            return [];
        }
        const parts = this.buffer.split('\n');
        this.buffer = parts.pop() || '';
        return parts;
    }
}

class IpcServer {
    /**
     * @param {object} opts
     * @param {Function} opts.handler  async (request) => responseObject
     * @param {object} opts.stateStore
     * @param {number} [opts.port]
     * @param {string} [opts.host] loopback only (P7)
     */
    constructor({ handler, stateStore, port = DEFAULT_PORT, host = '127.0.0.1' }) {
        if (host !== '127.0.0.1' && host !== 'localhost') {
            // P7: this is a single-operator local tool. A non-loopback bind would expose
            // an unauthenticated command channel to the network.
            throw new Error(
                `Refusing to bind ${host}. The gateway is loopback-only by policy.`
            );
        }
        this.handler = handler;
        this.state = stateStore;
        this.basePort = port;
        this.host = host;
        this.server = null;
        this.boundPort = null;
        this.openConnections = 0;
    }

    /**
     * Bind, and fail loudly if the port is taken.
     *
     * The previous behaviour silently moved to port+1. That is worse than failing:
     * the port fact then points a client at whichever process won 19222, and a client
     * probing candidates in order will happily talk to the wrong one - which, for a
     * second instance, means the legacy Electron app answering a gateway request.
     *
     * A relocation is still possible, but only when explicitly asked for, so the
     * operator knows two processes are sharing a protocol.
     */
    async listen({ allowRelocate = false } = {}) {
        let lastError = null;
        const maxPort = this.basePort + (allowRelocate ? FALLBACK_ATTEMPTS : 0);

        for (let port = this.basePort; port <= maxPort; port += 1) {
            try {
                const bound = await this._tryListen(port);
                this.boundPort = bound;
                this.state.recordPortFact(bound);
                if (port !== this.basePort) {
                    log.warn(
                        `relocated to port ${bound}; another process holds ${this.basePort}. ` +
                            `Clients may reach the wrong process.`
                    );
                }
                return bound;
            } catch (e) {
                lastError = e;
                if (e.code === 'EADDRINUSE') continue;
                throw e;
            }
        }

        const fact = this.state.readPortFact();
        throw new Error(
            `Port ${this.basePort} is already in use` +
                (fact && fact.pid ? ` by pid ${fact.pid}` : '') +
                '. Stop the other Proxima, or start this one on a different port:' +
                ` AGENT_HUB_PORT=<port> node src/index.js` +
                ' (or set PROXIMA_GATEWAY_PORT=1 to relocate automatically).'
        );
    }

    _tryListen(port) {
        return new Promise((resolve, reject) => {
            const server = net.createServer((socket) => this._onConnection(socket));
            const onError = (e) => {
                // Discard the failed server. Leaving it constructed keeps a handle on
                // the event loop, which surfaces later as an unrelated test-file
                // timeout rather than as the bind failure that actually happened.
                try {
                    server.close();
                } catch {
                    /* never listened, nothing to close */
                }
                reject(e);
            };
            server.once('error', onError);
            server.listen(port, this.host, () => {
                server.removeListener('error', onError);
                this.server = server;
                resolve(server.address().port);
            });
        });
    }

    _onConnection(socket) {
        this.openConnections += 1;
        const decoder = new FrameDecoder();
        let busy = Promise.resolve();

        socket.on('close', () => {
            this.openConnections -= 1;
        });

        socket.on('data', (chunk) => {
            let lines;
            try {
                lines = decoder.push(chunk.toString('utf8'));
            } catch {
                return;
            }

            for (const line of lines) {
                if (!line.trim()) continue;
                // Serialize per-connection so responses cannot interleave out of order.
                busy = busy.then(() => this._respond(socket, line));
            }
        });

        socket.on('error', () => {
            /* a client vanishing mid-turn is normal, not an error condition */
        });
    }

    async _respond(socket, line) {
        let requestId = null;
        try {
            let request;
            try {
                request = JSON.parse(line);
            } catch {
                // F5: one unparseable frame must not kill the connection.
                //
                // A client correlates on requestId, so a response carrying null would
                // leave that request pending forever. Salvage the id textually so the
                // client can still match and see the error.
                this._write(socket, {
                    requestId: salvageRequestId(line),
                    success: false,
                    error: 'Malformed JSON frame',
                    errorKind: 'protocol',
                });
                return;
            }
            requestId = request.requestId ?? null;

            if (typeof request.action !== 'string' || !request.action) {
                this._write(socket, {
                    requestId,
                    success: false,
                    error: 'Request is missing an "action"',
                });
                return;
            }

            const response = await this.handler(request);
            // Redact SUCCESS responses too. getCookies returns session cookies,
            // debugDOM can return page HTML and executeScript returns whatever the
            // page returned - any of which can carry a credential. Previously only
            // the failure branch was redacted, so secrets left over the wire on the
            // paths that actually return them.
            this._write(socket, { ...redact(response || {}), requestId });
        } catch (e) {
            // Redacted: the failure can come from anywhere in the request path, and a
            // provider URL can carry a token in its query string.
            this._write(socket, { requestId, ...toSafeError(e) });
        }
    }

    _write(socket, obj) {
        if (socket.destroyed) return;
        try {
            socket.write(JSON.stringify(obj) + '\n');
        } catch {
            /* peer closed between check and write */
        }
    }

    async close() {
        this.state.clearPortFact();
        if (!this.server) return;
        await new Promise((resolve) => this.server.close(resolve));
        this.server = null;
    }
}

module.exports = { IpcServer, FrameDecoder, salvageRequestId, MAX_LINE_BYTES, DEFAULT_PORT };
