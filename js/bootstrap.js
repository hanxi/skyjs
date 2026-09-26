"use strict";

// Runtime bootstrap. It is loaded as a normal module by js/loader.js, but
// runs before the user service entry. New globals are added in later NC0
// subbatches; this file only owns registration and the main-module handoff.

const { register } = require("./internal/module-registry.js");
const eventLoop = require("./internal/event-loop.js");
const processModule = require("./internal/process.js");
const textCodec = require("./internal/text-codec.js");
const abort = require("./internal/abort.js");
const bufferCore = require("./internal/buffer-core.js");

// Install the encoding/abort globals before loading the cores that use them.
if (typeof globalThis.TextEncoder === "undefined") {
    globalThis.TextEncoder = textCodec.TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
    globalThis.TextDecoder = textCodec.TextDecoder;
}
if (typeof globalThis.Buffer === "undefined") {
    globalThis.Buffer = bufferCore.Buffer;
}
if (typeof globalThis.Blob === "undefined") {
    globalThis.Blob = bufferCore.Blob;
}
if (typeof globalThis.File === "undefined") {
    globalThis.File = bufferCore.File;
}
const urlCore = require("./internal/url-core.js");
if (typeof globalThis.URL === "undefined") {
    globalThis.URL = urlCore.URL;
}
if (typeof globalThis.URLSearchParams === "undefined") {
    globalThis.URLSearchParams = urlCore.URLSearchParams;
}
abort.install();
eventLoop.install();

// Engine library cores: each registers its routing state on load. They no
// longer publish legacy globals (NC0.8); services require() the module they use.
require("./internal/skynet-core.js");
require("./internal/net-core.js");
require("./internal/crypt-core.js");
require("./internal/http-core.js");
require("./internal/fs-core.js");
require("./builtins/skyjs/cluster.js");
require("./builtins/skyjs/gateserver.js");
// fetch is a global, not a require() entry (§3).
require("./builtins/fetch.js").install();

function assertReadyGlobal(name) {
    if (typeof globalThis[name] === "undefined") {
        throw new Error("runtime bootstrap is missing global: " + name);
    }
}

function runMain(moduleSystem, entry, param) {
    register(moduleSystem);
    processModule.install();
    globalThis.global = globalThis;
    globalThis.snjsParam = param;
    globalThis.__snjs_event_loop_tick = eventLoop.tick;
    const consoleObject = require("./builtins/console.js");
    globalThis.console = consoleObject;
    assertReadyGlobal("console");
    assertReadyGlobal("skynet");
    assertReadyGlobal("TextEncoder");
    assertReadyGlobal("TextDecoder");
    assertReadyGlobal("Buffer");
    assertReadyGlobal("Blob");
    assertReadyGlobal("File");
    assertReadyGlobal("URL");
    assertReadyGlobal("URLSearchParams");
    assertReadyGlobal("fetch");
    assertReadyGlobal("AbortController");
    assertReadyGlobal("AbortSignal");
    assertReadyGlobal("setTimeout");
    assertReadyGlobal("setImmediate");
    return moduleSystem.runMain(entry);
}

module.exports = { runMain };
