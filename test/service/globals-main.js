"use strict";

const required = [
    "global", "process", "console", "Buffer",
    "setTimeout", "clearTimeout", "setInterval", "clearInterval",
    "setImmediate", "clearImmediate", "queueMicrotask",
    "TextEncoder", "TextDecoder", "AbortController", "AbortSignal",
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

skynetcore.error("GLOBALS_OK events=1 buffer=1 abort=1");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "GLOBALS:" + msg);
});
