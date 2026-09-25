"use strict";

// Structured logging helper. Bridges to skynetcore.runtime.error so output
// stays on the skynet log channel with the service handle prefix.

function stringify(value) {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
}

function emit(level, fields) {
    const payload = Object.assign({ level, t: Date.now() }, fields);
    skynetcore.runtime.error(stringify(payload));
}

function createLogger(base) {
    const bound = base || {};
    const logger = {};
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
        logger[level] = function (...args) {
            let fields;
            if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
                fields = Object.assign({}, bound, args[0]);
            } else {
                fields = Object.assign({}, bound, { msg: args.map(stringify).join(" ") });
            }
            emit(level, fields);
        };
    }
    logger.child = (extra) => createLogger(Object.assign({}, bound, extra));
    return logger;
}

const defaultLogger = createLogger();
defaultLogger.createLogger = createLogger;

module.exports = defaultLogger;
