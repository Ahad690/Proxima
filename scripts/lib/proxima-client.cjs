/**
 * proxima-client.cjs
 * Sends repair prompts to Proxima Agent Hub via IPC TCP socket (port 19222).
 * Uses the same protocol as proxima-review.cjs — no REST API required.
 */
const net = require('net');

const IPC_PORT = parseInt(process.env.AGENT_HUB_PORT) || 19222;
const IPC_HOST = '127.0.0.1';

function resolveProvider(model) {
    if (!model) return 'chatgpt';
    const m = model.toLowerCase();
    if (m === 'chatgpt' || m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'chatgpt';
    return 'perplexity';
}

function resolveThinkingEffort(model, explicitEffort) {
    if (explicitEffort) return explicitEffort;
    if (!model) return 'standard';
    const m = model.toLowerCase();
    return m.includes('thinking') ? 'extended' : 'standard';
}

/**
 * Send a prompt to Proxima via IPC and return the text response.
 * @param {string} message  - The full prompt text
 * @param {string} model    - Model name (e.g. "chatgpt", "claude", "gpt-5-5-thinking")
 * @param {string} _baseUrl - Ignored; kept for API compatibility
 * @param {object} opts     - Optional: { thinkingEffort: "standard" | "extended" }
 */
async function askProxima(message, model, _baseUrl, opts = {}) {
    const provider = resolveProvider(model);
    const thinkingEffort = resolveThinkingEffort(model, opts.thinkingEffort);

    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port: IPC_PORT, host: IPC_HOST });
        let buffer = '';
        let state = 'waitingSendAck';
        let reqId = 0;

        socket.setTimeout(600000); // 10 min max

        function ipcSend(action, data) {
            reqId++;
            socket.write(JSON.stringify({ requestId: reqId, action, provider, data }) + '\n');
            return reqId;
        }

        function buildSendPayload() {
            if (provider === 'chatgpt') {
                return { message, model, thinkingEffort };
            }
            return { message, modelPreference: model, deepSearch: false };
        }

        socket.on('connect', () => {
            ipcSend('sendMessage', buildSendPayload());
        });

        socket.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const resp = JSON.parse(line);

                    if (state === 'waitingSendAck' && resp.requestId === 1) {
                        if (!resp.success) {
                            socket.destroy();
                            reject(new Error(resp.error || 'sendMessage failed'));
                            return;
                        }
                        state = 'waitingResponse';
                        ipcSend('getResponseWithTyping', {});

                    } else if (state === 'waitingResponse' && resp.requestId === 2) {
                        state = 'done';
                        socket.end();
                        const text = resp.response || '';
                        if (!text) {
                            reject(new Error(provider + ' returned empty response'));
                        } else {
                            resolve(text);
                        }
                    }
                } catch { /* ignore parse errors */ }
            }
        });

        socket.on('error', (e) => {
            reject(e.code === 'ECONNREFUSED'
                ? new Error(`Cannot connect to Proxima Agent Hub on port ${IPC_PORT}. Is Proxima running?`)
                : e);
        });

        socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('IPC request to Proxima timed out after 10 minutes'));
        });
    });
}

module.exports = { askProxima, resolveThinkingEffort };
