"use strict";

// Node-style process object for a single skynet actor. The exit-code slot is
// shared with the host through platform/runtime-exit.c; this file owns the JS
// facade and the internal exit sentinel.

const EXIT_SENTINEL_CODE = "__skyjsProcessExit";

function exitSentinel(code) {
    const err = new Error("process.exit(" + code + ")");
    err.code = EXIT_SENTINEL_CODE;
    err.exitCode = code;
    return err;
}

function isExitSentinel(err) {
    return err !== null && typeof err === "object" &&
        err.code === EXIT_SENTINEL_CODE;
}

function unsupported(name) {
    const err = new Error(name + " is not supported in SkyJS");
    err.code = "ERR_UNSUPPORTED_PLATFORM";
    return err;
}

function writeLine(stream, text) {
    const value = typeof text === "string" ? text : String(text);
    for (const line of value.split("\n")) {
        skynetcore.error(line);
    }
}

class ProcessWriteStream {
    constructor() {
        this.isTTY = false;
        this._listeners = new Map();
    }

    write(chunk, encoding, callback) {
        let cb = callback;
        if (typeof encoding === "function") cb = encoding;
        writeLine(this, chunk);
        if (typeof cb === "function") cb();
        return true;
    }

    on(event, listener) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(listener);
        return this;
    }

    once(event, listener) {
        const wrapper = (...args) => {
            this.removeListener(event, wrapper);
            listener(...args);
        };
        return this.on(event, wrapper);
    }

    off(event, listener) {
        return this.removeListener(event, listener);
    }

    removeListener(event, listener) {
        const list = this._listeners.get(event);
        if (list) {
            const index = list.indexOf(listener);
            if (index >= 0) list.splice(index, 1);
        }
        return this;
    }

    emit(event, ...args) {
        const list = this._listeners.get(event);
        if (!list) return false;
        for (const listener of list.slice()) listener(...args);
        return true;
    }
}

function installProcessObject() {
    const info = skynetcore.runtime.info();
    const argv = skynetcore.runtime.argv();
    const env = skynetcore.runtime.environ();
    const processObj = globalThis.process || {};

    processObj.version = "v20.0.0";
    processObj.versions = {
        node: "20.0.0",
        skyjs: info.version,
        quickjs: "0.16.2",
    };
    processObj.platform = info.platform;
    processObj.arch = info.arch;
    processObj.pid = info.pid;
    processObj.ppid = info.ppid;
    processObj.argv = argv;
    processObj.argv0 = argv[0];
    processObj.execPath = info.execPath;
    processObj.env = env;
    processObj.cwd = function () { return "/"; };
    processObj.chdir = function () { throw unsupported("process.chdir()"); };

    if (typeof processObj.nextTick !== "function") {
        const eventLoop = require("./event-loop.js");
        processObj.nextTick = eventLoop.nextTick;
    }

    let exitCode = 0;
    Object.defineProperty(processObj, "exitCode", {
        configurable: true,
        enumerable: true,
        get() { return exitCode; },
        set(value) {
            exitCode = Number(value) | 0;
            skynetcore.runtime.exitCode(exitCode);
        },
    });
    processObj.exit = function (code) {
        const value = code === undefined ? exitCode : Number(code) | 0;
        skynetcore.runtime.exit(value);
        throw exitSentinel(value);
    };
    processObj.hrtime = function (previous) {
        const now = skynetcore.runtime.hrtime();
        if (previous === undefined) return now;
        let sec = now[0] - previous[0];
        let nsec = now[1] - previous[1];
        if (nsec < 0) {
            sec -= 1;
            nsec += 1000000000;
        }
        return [sec, nsec];
    };
    processObj.hrtime.bigint = function () {
        const now = skynetcore.runtime.hrtime();
        return BigInt(now[0]) * 1000000000n + BigInt(now[1]);
    };
    processObj.memoryUsage = function () {
        const used = skynetcore.mem();
        return {
            rss: used,
            heapTotal: used,
            heapUsed: used,
            external: 0,
        };
    };
    processObj.uptime = function () {
        return skynetcore.runtime.info().uptime;
    };
    processObj.stdout = new ProcessWriteStream();
    processObj.stderr = new ProcessWriteStream();
    processObj.stdin = null;

    globalThis.process = processObj;
    return processObj;
}

module.exports = {
    install: installProcessObject,
    exitSentinel,
    isExitSentinel,
};
