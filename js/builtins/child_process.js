"use strict";

// Node `child_process` facade over internal/subprocess-core (`.subprocess`
// owner). No extra process capability is introduced here (§10.2).

const core = require("../internal/subprocess-core.js");
const errors = require("../internal/errors.js");

function assertEnabled() {
    if (!(skynetcore.subprocess && skynetcore.subprocess.enabled)) {
        throw errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
            "child_process is not compiled into this build (SUBPROCESS=0)");
    }
}

function spawn(command, args, options) {
    assertEnabled();
    const child = core.spawn(command, args || [], options || {});
    return child;
}

function exec(command, options, callback) {
    assertEnabled();
    const opts = typeof options === "function" ? {} : (options || {});
    const cb = typeof options === "function" ? options : callback;
    const parts = String(command).split(/\s+/);
    const program = parts.shift();
    const promise = core.exec(program, parts, opts);
    if (typeof cb === "function") {
        promise.then(
            (result) => cb(null, result.stdout, result.stderr),
            (err) => cb(err, err.stdout || "", ""));
    }
    return promise;
}

function execFile(file, args, options, callback) {
    assertEnabled();
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options || {});
    const promise = core.exec(file, args || [], opts);
    if (typeof cb === "function") {
        promise.then(
            (result) => cb(null, result.stdout, result.stderr),
            (err) => cb(err, err.stdout || "", ""));
    }
    return promise;
}

module.exports = { spawn, exec, execFile };
