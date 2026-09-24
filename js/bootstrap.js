"use strict";

// Runtime bootstrap. It is loaded as a normal module by js/loader.js, but
// runs before the user service entry. New globals are added in later NC0
// subbatches; this file only owns registration and the main-module handoff.

const { register } = require("./internal/module-registry.js");
const eventLoop = require("./internal/event-loop.js");

function assertReadyGlobal(name) {
    if (typeof globalThis[name] === "undefined") {
        throw new Error("runtime bootstrap is missing global: " + name);
    }
}

function runMain(moduleSystem, entry, param) {
    register(moduleSystem);
    eventLoop.install();
    globalThis.global = globalThis;
    globalThis.snjsParam = param;
    globalThis.__snjs_event_loop_tick = eventLoop.tick;
    assertReadyGlobal("console");
    assertReadyGlobal("skynet");
    assertReadyGlobal("TextEncoder");
    assertReadyGlobal("TextDecoder");
    assertReadyGlobal("setTimeout");
    assertReadyGlobal("setImmediate");
    return moduleSystem.runMain(entry);
}

module.exports = { runMain };
