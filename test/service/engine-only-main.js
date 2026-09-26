"use strict";

// packages/ removal gate (node-compatibility §10 收口标准, §16.4.1):
// with the whole `packages/` tree deleted, the engine must still boot and every
// layer-1 module plus every engine-internal `skyjs/*` entry must load and expose
// its contracted surface. Run via tools/check-packages-boundary.js, which hides
// packages/ before invoking this scenario.

const testing = require("skyjs/testing");

// ---- layer 1: Node-spec modules (must be engine-internal) -----------------
const layer1 = [
    "events", "buffer", "stream", "stream/promises", "fs", "fs/promises",
    "path", "util", "querystring", "url", "os", "net", "tls", "http",
    "https", "crypto", "zlib", "child_process",
];
for (const id of layer1) {
    const mod = require(id);
    testing.ok(mod !== undefined && mod !== null, "layer1 module loads: " + id);
}
testing.ok(typeof require("stream").Readable === "function", "stream.Readable");
testing.ok(typeof require("fs").readFileSync === "function", "fs.readFileSync");
testing.ok(typeof require("net").createServer === "function", "net.createServer");
testing.ok(typeof require("http").createServer === "function", "http.createServer");
testing.ok(typeof require("crypto").createHash === "function", "crypto.createHash");
testing.ok(typeof require("zlib").gzipSync === "function", "zlib.gzipSync");

// ---- engine-internal skyjs/* entries (§16.4.1, must not live in packages/) --
const engineEntries = [
    // [id, probe]
    ["skyjs/fsx", (m) => typeof m.readFile === "function"],
    ["skyjs/subprocess", (m) => typeof m.spawn === "function"],
    ["skyjs/crypt", (m) => typeof m.sha256 === "function"],
    ["skyjs/cluster", (m) => typeof m.init === "function"],
    ["skyjs/gateserver", (m) => typeof m.open === "function"],
    ["skyjs/log", (m) => typeof m.info === "function"],
    ["skyjs/testing", (m) => typeof m.ok === "function"],
];
for (const [id, probe] of engineEntries) {
    const mod = require(id);
    testing.ok(probe(mod), "engine entry surface: " + id);
    // The engine entry must resolve to js/builtins/skyjs/**, never to a package.
    const isInternal = typeof mod === "object" && mod !== null;
    testing.ok(isInternal, "engine entry is an object: " + id);
}

// ---- the engine must not need any @skyjs package to boot ------------------
// packages/ is hidden while this scenario runs, so requiring a package-only
// entry must fail with MODULE_NOT_FOUND -- proving the engine never depended on
// it. (If this ever succeeds, packages/ was not actually hidden.)
let leaked = null;
try {
    require("skyjs/websocket");
} catch (err) {
    leaked = err;
}
testing.ok(leaked !== null && leaked.code === "MODULE_NOT_FOUND",
    "package-only entry is unavailable without packages/");

skynetcore.runtime.error("ENGINE_ONLY_OK layer1=" + layer1.length +
    " entries=" + engineEntries.length + " checks=" + testing.summary().checks);

skynet.start(() => {
    skynet.dispatch("text", (msg) => "ENGINE_ONLY:" + msg);
});
