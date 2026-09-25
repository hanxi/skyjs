"use strict";

const required = [
    "global", "process", "console", "Buffer", "Blob", "File",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "setImmediate", "clearImmediate", "queueMicrotask",
    "TextEncoder", "TextDecoder", "AbortController", "AbortSignal",
    "URL", "URLSearchParams",
    "skynet",
];
for (const name of required) {
    if (typeof globalThis[name] === "undefined") {
        throw new Error("missing global: " + name);
    }
}
for (const name of ["require", "module", "exports", "__filename",
    "__dirname", "fetch", "WebSocket", "structuredClone"]) {
    if (globalThis[name] !== undefined) {
        throw new Error("unexpected global: " + name);
    }
}

const events = require("events");
const emitter = new events.EventEmitter();
let eventValue = 0;
emitter.on("value", (v) => { eventValue = v; });
emitter.emit("value", 42);
if (eventValue !== 42) throw new Error("events builtin failed");

const controller = new AbortController();
let aborted = 0;
controller.signal.addEventListener("abort", () => { aborted++; });
controller.abort();
if (!controller.signal.aborted || aborted !== 1) {
    throw new Error("AbortController failed");
}

if (Buffer.from("aGVsbG8=", "base64").toString() !== "hello" ||
        Buffer.allocUnsafe(2).join(",") !== "0,0") {
    throw new Error("Buffer failed");
}

// NC0.8 exit criteria: only §3 globals (+skynet/LuaTable) remain, and the
// skynetcore namespace exposes grouped names only.
// No legacy SkyJS globals may remain (language intrinsics stay, of course).
for (const name of ["io", "httpd", "httpc", "httpInternal", "websocket",
    "socket", "sockethelper", "crypt", "cluster", "gateserver", "require",
    "module", "exports", "__filename", "__dirname"]) {
    if (globalThis[name] !== undefined) {
        throw new Error("legacy global still present: " + name);
    }
}
// NC0.8 contract: grouped namespaces only. `tls` is OpenSSL-only and
// `subprocess` is present unless the build sets SUBPROCESS=0.
const requiredNamespaces = ["crypt", "features", "fs", "net", "netpack",
    "runtime", "seri"];
const namespaces = Object.keys(skynetcore).sort();
for (const name of requiredNamespaces) {
    if (!namespaces.includes(name)) {
        throw new Error("missing skynetcore namespace: " + name);
    }
}
const allowed = requiredNamespaces.concat(["tls", "subprocess"]);
for (const name of namespaces) {
    if (!allowed.includes(name)) {
        throw new Error("unexpected skynetcore namespace: " + name);
    }
}

skynetcore.runtime.error("GLOBALS_OK events=1 buffer=1 abort=1");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "GLOBALS:" + msg);
});
