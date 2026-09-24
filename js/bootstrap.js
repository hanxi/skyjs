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
require("./internal/skynet-core.js");

function assertReadyGlobal(name) {
    if (typeof globalThis[name] === "undefined") {
        throw new Error("runtime bootstrap is missing global: " + name);
    }
}

function runMain(moduleSystem, entry, param) {
    register(moduleSystem);
    eventLoop.install();
    processModule.install();
    abort.install();
    globalThis.global = globalThis;
    globalThis.snjsParam = param;
    globalThis.__snjs_event_loop_tick = eventLoop.tick;
    if (typeof globalThis.TextEncoder === "undefined") {
        globalThis.TextEncoder = textCodec.TextEncoder;
    }
    if (typeof globalThis.TextDecoder === "undefined") {
        globalThis.TextDecoder = textCodec.TextDecoder;
    }
    if (typeof globalThis.Buffer === "undefined") {
        globalThis.Buffer = bufferCore.Buffer;
    }
    const consoleObject = require("./builtins/console.js");
    globalThis.console = consoleObject;
    assertReadyGlobal("console");
    assertReadyGlobal("skynet");
    assertReadyGlobal("TextEncoder");
    assertReadyGlobal("TextDecoder");
    assertReadyGlobal("Buffer");
    assertReadyGlobal("AbortController");
    assertReadyGlobal("AbortSignal");
    assertReadyGlobal("setTimeout");
    assertReadyGlobal("setImmediate");
    return moduleSystem.runMain(entry);
}

module.exports = { runMain };
