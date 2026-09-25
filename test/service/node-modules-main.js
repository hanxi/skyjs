"use strict";

// NC1.5 acceptance: node_modules resolution for bare names, scoped packages,
// subpaths, package.json#main, and builtin-before-filesystem priority.

const testing = require("skyjs/testing");

// bare package name
const bare = require("mod-bare");
testing.equal(bare.name, "bare", "bare package name");

// scoped package
const scoped = require("@scope/mod-scoped");
testing.equal(scoped.name, "scoped", "scoped package name");

// subpath into a package
const sub = require("mod-bare/lib/util.js");
testing.equal(sub.value, "util", "package subpath");

// package.json#main pointing at a non-index file
const mainPkg = require("mod-main");
testing.equal(mainPkg.source, "main-field", "package.json#main");

// directory with index.json
const indexJson = require("mod-json");
testing.equal(indexJson.kind, "json-index", "index.json entry");

// builtin wins over a node_modules package of the same name
const events = require("events");
testing.ok(typeof events.EventEmitter === "function", "builtin shadows filesystem");

skynetcore.runtime.error("NODE_MODULES_OK bare=1 scoped=1 subpath=1 main=1 json=1 builtin=1 checks=" +
    testing.summary().checks);

skynet.start(() => {
    skynet.dispatch("text", (msg) => "NODE_MODULES:" + msg);
});
