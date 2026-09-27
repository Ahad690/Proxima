'use strict';

const { redact, redactString, REDACTED, containsSecret } = require('./redact');

/**
 * Structured logging with redaction applied at the sink.
 *
 * There is deliberately no raw console.log path in this codebase. Anything an operator
 * might read has to go through here, so redaction cannot be forgotten at a call site.
 *
 * Redaction happens at the sink rather than the source because call sites should not
 * have to know which of their values are secret - that judgement changes as providers
 * change, and a missed call site is a credential in a log file.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
    const raw = String(process.env.PROXIMA_GATEWAY_LOG_LEVEL || 'info').toLowerCase();
    return LEVELS[raw] ?? LEVELS.info;
}

function enabled(level) {
    return LEVELS[level] >= currentLevel();
}

/**
 * Emit one record. Every argument is redacted before it can reach a stream.
 */
function emit(level, stream, args) {
    if (!enabled(level)) return;
    const parts = args.map((a) => {
        if (typeof a === 'string') return redactString(a);
        return safeStringify(a);
    });
    stream.write(`[gateway:${level}] ${parts.join(' ')}\n`);
}

function safeStringify(value) {
    try {
        return JSON.stringify(redact(value, { max: 2048 }));
    } catch {
        return '[unserialisable]';
    }
}

const log = {
    debug: (...a) => emit('debug', process.stdout, a),
    info: (...a) => emit('info', process.stdout, a),
    warn: (...a) => emit('warn', process.stderr, a),
    error: (...a) => emit('error', process.stderr, a),

    /**
     * Report an error safely.
     *
     * A stack is the highest-risk string in this system: it can quote the URL that was
     * being fetched, and a provider URL can carry a token. The stack is preserved for
     * diagnosis, but only after redaction.
     */
    exception: (err, context = {}) => {
        if (!enabled('error')) return;
        const out = { ...context };
        if (err) {
            out.name = err.name;
            out.message = redactString(err.message);
            if (err.code) out.code = err.code;
            if (err.kind) out.kind = err.kind;
            if (err.provider) out.provider = err.provider;
            if (err.stack) out.stack = redactString(err.stack, { max: 2048 });
        }
        process.stderr.write(`[gateway:error] ${safeStringify(out)}\n`);
    },
};

/**
 * Normalise anything thrown into a redacted, wire-safe shape.
 * Used at every boundary where an internal error becomes an external response.
 *
 * Always includes success:false. A caller must never receive a response that is neither
 * a success nor a failure, because it will read the missing field as "probably fine".
 */
function toSafeError(err, extra = {}) {
    if (typeof err === 'string') {
        return { success: false, error: redactString(err), ...extra };
    }
    const out = {
        success: false,
        error: redactString(err && err.message ? err.message : String(err)),
        ...extra,
    };
    if (err && err.kind) out.errorKind = err.kind;
    if (err && err.provider) out.provider = err.provider;
    if (err && err.code) out.code = err.code;
    return out;
}

module.exports = { log, toSafeError, LEVELS, REDACTED, containsSecret };
