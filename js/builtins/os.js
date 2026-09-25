"use strict";

// Node-compatible `os` subset. Platform data comes from
// skynetcore.runtime.info(); tmpdir/homedir come from the Actor environ.

function info() {
    return skynetcore.runtime.info();
}

function platform() {
    return info().platform;
}

function arch() {
    return info().arch;
}

function type() {
    return platform() === "darwin" ? "Darwin" : "Linux";
}

function release() {
    return "";
}

function hostname() {
    const env = skynetcore.runtime.environ();
    return env.HOSTNAME || env.HOST || "";
}

function tmpdir() {
    const env = skynetcore.runtime.environ();
    if (env.TMPDIR) return env.TMPDIR.replace(/\/+$/, "");
    if (platform() === "darwin") return "/tmp";
    return env.TMPDIR || "/tmp";
}

function homedir() {
    const env = skynetcore.runtime.environ();
    return env.HOME || env.USERPROFILE || "";
}

function endianness() {
    const probe = new Uint16Array([1]);
    return new Uint8Array(probe.buffer)[0] === 1 ? "LE" : "BE";
}

const EOL = "\n";

function cpus() {
    return [{
        model: "",
        speed: 0,
        times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    }];
}

function totalmem() {
    return 0;
}

function freemem() {
    return 0;
}

function uptime() {
    return info().uptime;
}

function loadavg() {
    return [0, 0, 0];
}

function networkInterfaces() {
    return {};
}

function userInfo() {
    const env = skynetcore.runtime.environ();
    return {
        username: env.USER || env.USERNAME || "",
        uid: -1,
        gid: -1,
        shell: env.SHELL || null,
        homedir: homedir(),
    };
}

const constants = {
    signals: {},
    errno: require("../internal/errors.js").ERRNO_POSITIVE,
    priority: {},
};

module.exports = {
    EOL,
    arch,
    constants,
    cpus,
    endianness,
    freemem,
    homedir,
    hostname,
    loadavg,
    networkInterfaces,
    platform,
    release,
    tmpdir,
    totalmem,
    type,
    uptime,
    userInfo,
};
