"use strict";

// The single rule table used by the CJS loader. Builtins are resolved before
// the filesystem; a missing Node builtin may still fall back to the ordinary
// third-party resolver so bare package names remain usable.

const path = require("./path-posix.js");
const engineRoot = path.resolve("./js");

function resolve(request) {
    if (typeof request !== "string" || request === "") return null;
    const nodePrefix = request.startsWith("node:");
    if (nodePrefix) request = request.slice(5);

    if (request.startsWith("internal/") || request.startsWith("js/internal/")) {
        const id = request.startsWith("internal/") ?
            request : request.slice(3);
        return { id, kind: "internal", fallback: null };
    }
    if (request === "crypto" || request === "zlib") {
        return { id: "builtins/" + request, kind: "builtin", fallback: null };
    }
    if (request === "http" || request === "https") {
        return { id: "builtins/" + request, kind: "builtin", fallback: null };
    }
    if (request === "net" || request === "tls") {
        return { id: "builtins/" + request, kind: "builtin", fallback: null };
    }
    if (request === "child_process") {
        return { id: "builtins/child_process", kind: "builtin", fallback: null };
    }
    if (request === "fs" || request.startsWith("fs/")) {
        // fs -> builtins/fs/index.js, fs/promises -> builtins/fs/promises.js
        const sub = request === "fs" ? "index" : request.slice(3);
        return { id: "builtins/fs/" + sub, kind: "builtin", fallback: null };
    }
    if (request === "stream" || request.startsWith("stream/")) {
        // stream/promises lives next to the main facade.
        return {
            id: "builtins/stream/" + (request === "stream" ? "index" : request.slice(7)),
            kind: "builtin",
            fallback: null,
        };
    }
    if (request.startsWith("skyjs/")) {
        return {
            id: "builtins/" + request,
            kind: "builtin",
            fallback: "@skyjs/" + request.slice(7),
        };
    }
    if (request.startsWith("./") || request.startsWith("../") ||
        request.startsWith("/") || request.startsWith("@")) {
        return null;
    }
    return {
        id: "builtins/" + request,
        kind: "builtin",
        fallback: nodePrefix ? null : request,
    };
}

function isInternalAllowed(parent) {
    if (parent === undefined || parent === null) return true;
    if (typeof parent !== "string") return false;
    const relative = path.relative(engineRoot, parent);
    return relative === "bootstrap.js" || relative === "loader.js" ||
        relative.startsWith("internal/") || relative.startsWith("builtins/");
}

function register(moduleSystem) {
    moduleSystem._registry = { resolve, isInternalAllowed };
}

module.exports = { resolve, isInternalAllowed, register };
