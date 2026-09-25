"use strict";

// Node-style error construction and errno mapping. This is the single source
// of truth for SkyJS error classification: engine libraries wrap failures with
// skyjsError(), Node facades use systemError() so err.code stays a Node code
// and the SkyJS class lands in err.detail.skyjsCode.

const ERRNO = {
    EPERM: -1, ENOENT: -2, ESRCH: -3, EINTR: -4, EIO: -5, ENXIO: -6,
    E2BIG: -7, ENOEXEC: -8, EBADF: -9, ECHILD: -10, EAGAIN: -11,
    ENOMEM: -12, EACCES: -13, EFAULT: -14, EBUSY: -16, EEXIST: -17,
    EXDEV: -18, ENODEV: -19, ENOTDIR: -20, EISDIR: -21, EINVAL: -22,
    ENFILE: -23, EMFILE: -24, ENOTTY: -25, EFBIG: -27, ENOSPC: -28,
    ESPIPE: -29, EROFS: -30, EMLINK: -31, EPIPE: -32, EDOM: -33,
    ERANGE: -34, EDEADLK: -35, ENAMETOOLONG: -36, ENOLCK: -37,
    ENOSYS: -38, ENOTEMPTY: -39, ELOOP: -40, EWOULDBLOCK: -11,
};

// Which SkyJS class each Node errno code belongs to.
const ERRNO_CLASS = {
    ENOENT: "ERR_NOT_FOUND",
    EACCES: "ERR_PERMISSION",
    EPERM: "ERR_PERMISSION",
    EEXIST: "ERR_IO",
    EISDIR: "ERR_IO",
    ENOTDIR: "ERR_IO",
    ENOTEMPTY: "ERR_IO",
    EMFILE: "ERR_LIMIT_EXCEEDED",
    ENFILE: "ERR_LIMIT_EXCEEDED",
    ENOSPC: "ERR_LIMIT_EXCEEDED",
    EAGAIN: "ERR_BUSY",
    EBUSY: "ERR_BUSY",
    EWOULDBLOCK: "ERR_BUSY",
    EINVAL: "ERR_PROTOCOL",
    ENOSYS: "ERR_UNSUPPORTED_PLATFORM",
    ENOTSUP: "ERR_UNSUPPORTED_PLATFORM",
    EOPNOTSUPP: "ERR_UNSUPPORTED_PLATFORM",
    EPIPE: "ERR_IO",
    EIO: "ERR_IO",
    EINTR: "ERR_CANCELLED",
    ETIMEDOUT: "ERR_TIMEOUT",
};

// C-side error text prefixes -> Node code. The C bridges throw message-only
// errors today (see service-src/js-io.c); this keeps the mapping table in one
// place and is extended as C starts returning structured errno (NC2.3).
const MESSAGE_HINTS = [
    [/can't open|failed to open|not found|no such file/i, "ENOENT", "open"],
    [/permission denied|access denied/i, "EACCES", "open"],
    [/failed to create|already exists/i, "EEXIST", "mkdir"],
    [/failed to remove|not empty/i, "ENOTEMPTY", "rm"],
    [/failed to rename|invalid cross-device/i, "EXDEV", "rename"],
    [/not supported/i, "ENOSYS", "unknown"],
];

function skyjsError(code, message, detail) {
    const err = new Error(message);
    err.code = code;
    err.detail = Object.assign({}, detail);
    if (err.detail.skyjsCode === undefined) err.detail.skyjsCode = code;
    return err;
}

function systemError(code, syscall, path, message) {
    const err = new Error(message || (code + ": " + syscall + " '" + path + "'"));
    err.code = code;
    err.errno = ERRNO[code] !== undefined ? ERRNO[code] : -1;
    err.syscall = syscall;
    if (path !== undefined) err.path = path;
    const skyjsCode = ERRNO_CLASS[code] || "ERR_IO";
    err.detail = { skyjsCode, errno: err.errno, syscall, path };
    return err;
}

/**
 * Normalize an arbitrary thrown value into a Node-shaped Error.
 * Already-shaped errors (have a valid err.code) pass through untouched.
 */
function normalizeError(value, context) {
    if (value instanceof Error && typeof value.code === "string") {
        return value;
    }
    for (const [pattern, code, syscall] of MESSAGE_HINTS) {
        if (typeof value.message === "string" && pattern.test(value.message)) {
            const path = context && context.path;
            const err = systemError(code, syscall, path,
                value.message);
            err.cause = value;
            return err;
        }
    }
    const err = new Error(value && value.message ? value.message : String(value));
    err.code = "ERR_INTERNAL";
    err.detail = { skyjsCode: "ERR_INTERNAL" };
    err.cause = value;
    return err;
}

function abortedError(reason) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    err.detail = { skyjsCode: "ERR_CANCELLED" };
    if (reason !== undefined) err.cause = reason;
    return err;
}

function timeoutError(ms) {
    const err = new Error("The operation timed out after " + ms + "ms");
    err.name = "TimeoutError";
    err.code = "ERR_TIMEOUT";
    err.detail = { skyjsCode: "ERR_TIMEOUT", timeoutMs: ms };
    return err;
}

function systemErrorName(errno) {
    for (const [name, value] of Object.entries(ERRNO)) {
        if (value === errno) return name;
    }
    const hex = (errno >>> 0).toString(16);
    return "Unknown system error " + errno + " (" + hex + ")";
}

// Positive errno values as exposed by os.constants.errno (Node convention).
const ERRNO_POSITIVE = {};
for (const [name, value] of Object.entries(ERRNO)) {
    ERRNO_POSITIVE[name] = Math.abs(value);
}

module.exports = {
    ERRNO,
    ERRNO_POSITIVE,
    systemErrorName,
    ERRNO_CLASS,
    skyjsError,
    systemError,
    normalizeError,
    abortedError,
    timeoutError,
};
