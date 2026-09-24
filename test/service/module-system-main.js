"use strict";

const cache = require("./module-system/cache.js");
const cacheAgain = require("./module-system/cache.js");
const cycleA = require("./module-system/cycle-a.js");
const cycleB = require("./module-system/cycle-b.js");
const files = require("./module-system/files.js");
const jsonData = require("./module-system/data.json");
const packageEntry = require("./module-system/package-entry/");
const sloppy = require("./module-system/sloppy.js");

if (cache !== cacheAgain) {
    throw new Error("module cache returned a second instance");
}
const count = cache.increment();
if (count !== 1) {
    throw new Error("module cache count is invalid: " + count);
}
if (cycleA.after !== "b" || cycleB.aTag !== "a") {
    throw new Error("circular module exports are invalid");
}
if (!Array.isArray(__filename.split("/")) ||
        !__filename.endsWith("module-system-main.js") ||
        !__dirname.endsWith("service")) {
    throw new Error("main module path variables are invalid");
}
if (!files.filename.endsWith("module-system/files.js") ||
        !files.dirname.endsWith("module-system") ||
        files.nodeModule !== "node_modules") {
    throw new Error("required module paths or node_modules resolution are invalid");
}
if (jsonData.value !== "json" || packageEntry.value !== "directory") {
    throw new Error("JSON or directory module resolution is invalid");
}
if (!sloppy.ok) {
    throw new Error("CJS wrapper unexpectedly enforces strict mode");
}
let internalBlocked = false;
try {
    require("internal/path-posix.js");
} catch (err) {
    internalBlocked = err.code === "ERR_PERMISSION";
}
let nodeInternalBlocked = false;
try {
    require("node:internal/path-posix.js");
} catch (err) {
    nodeInternalBlocked = err.code === "ERR_PERMISSION";
}
if (!internalBlocked || !nodeInternalBlocked) {
    throw new Error("private internal module permission is invalid");
}
if (globalThis.require !== undefined || globalThis.module !== undefined ||
        globalThis.exports !== undefined || globalThis.__filename !== undefined ||
        globalThis.__dirname !== undefined) {
    throw new Error("CJS wrapper variables leaked to globalThis");
}

skynetcore.error("MODULE_SYSTEM_OK cache=1 cycles=" +
    cycleB.aTag + "/" + cycleA.after + " locals=true file=true");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "MODULE_SYSTEM:" + msg);
});
