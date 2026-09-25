"use strict";

// `require('skyjs/subprocess')`: SkyJS-native process API over the
// `.subprocess` owner. child_process is a Node-shaped facade on the same core.

const core = require("../../internal/subprocess-core.js");
const errors = require("../../internal/errors.js");
const permission = require("../../internal/permission.js");

const named = new Map();

function spawn(program, args, options) {
    return core.spawn(program, args, options);
}

async function exec(program, args, options) {
    return core.exec(program, args, options);
}

async function start(name, program, args, options) {
    if (named.has(name)) {
        throw errors.skyjsError("ERR_BUSY", "process already running: " + name);
    }
    const child = await core.spawn(program, args, options);
    named.set(name, child);
    return { pid: child.pid };
}

async function stop(name) {
    const child = named.get(name);
    if (!child) return;
    child.kill();
    await child.wait();
    named.delete(name);
}

async function isRunning(name) {
    const child = named.get(name);
    if (!child) return false;
    const { header } = await core.call({ op: "status", pid: child.pid });
    return header.exited !== true;
}

async function list() {
    return Array.from(named.entries()).map(([name, child]) => ({
        name, pid: child.pid,
    }));
}

module.exports = {
    spawn,
    exec,
    start,
    stop,
    isRunning,
    list,
    version: "0.1.0",
    permission,
};
