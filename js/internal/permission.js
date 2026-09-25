"use strict";

// Path-boundary / quota / capability authorization, shared by the .fs and
// .subprocess owners and the plugin host. Pure logic: no I/O, no globals.

const path = require("./path-posix.js");
const errors = require("./errors.js");

const DEFAULT_MAX_READ_BYTES = 64 * 1024 * 1024;

class Permission {
    constructor(options) {
        const opts = options || {};
        this.roots = (opts.roots || []).map((root) => path.resolve(root));
        this.maxReadBytes = opts.maxReadBytes || DEFAULT_MAX_READ_BYTES;
        this.allowAbsolute = opts.allowAbsolute === true;
        this.readOnly = opts.readOnly === true;
    }

    /**
     * Resolve `target` and enforce that it stays inside one of the configured
     * roots. Returns the normalized absolute path, or throws ERR_PERMISSION.
     */
    resolvePath(target, base) {
        const absolute = path.resolve(base || "/", target);
        if (this.roots.length === 0) return absolute;
        for (const root of this.roots) {
            if (absolute === root || absolute.startsWith(root + "/")) {
                return absolute;
            }
        }
        throw errors.skyjsError("ERR_PERMISSION",
            "path escapes permitted root: " + target,
            { path: absolute, roots: this.roots.slice() });
    }

    /** Enforce the byte quota for a single read/write. */
    checkQuota(bytes, op) {
        if (typeof bytes !== "number" || bytes < 0) {
            throw errors.skyjsError("ERR_PROTOCOL", "invalid byte count for " + op);
        }
        if (bytes > this.maxReadBytes) {
            throw errors.skyjsError("ERR_LIMIT_EXCEEDED",
                op + " exceeds quota (" + bytes + " > " + this.maxReadBytes + ")",
                { limit: this.maxReadBytes, requested: bytes, op });
        }
        return bytes;
    }

    /** Deny mutating operations in read-only mode. */
    checkWrite(op, target) {
        if (this.readOnly) {
            throw errors.skyjsError("ERR_PERMISSION",
                op + " denied: read-only permission set",
                { op, path: target });
        }
    }

    /**
     * Capability check used by the plugin host: `granted` is the manifest's
     * capability list.
     */
    checkCapability(granted, capability) {
        if (!Array.isArray(granted) || !granted.includes(capability)) {
            throw errors.skyjsError("ERR_PERMISSION",
                "capability not granted: " + capability,
                { capability, granted });
        }
    }
}

/** Default actor-scoped permission set: full access under the CWD. */
function defaultPermission() {
    return new Permission({ roots: [], maxReadBytes: DEFAULT_MAX_READ_BYTES });
}

module.exports = { Permission, defaultPermission, DEFAULT_MAX_READ_BYTES };
