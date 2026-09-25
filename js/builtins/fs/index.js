"use strict";

// Node `fs` facade: callback + sync + Promise forms over internal/fs-sync.
// Side-effect free helpers are shared with `skyjs/fsx` (node-compatibility §8,
// §16.6).

const sync = require("../../internal/fs-sync.js");
const constants = require("./constants.js");
const { Stats, Dirent } = require("./stats.js");
const promises = require("./promises.js");
const errors = require("../../internal/errors.js");

function callbackify(fn) {
    return function (...args) {
        const callback = args.pop();
        if (typeof callback !== "function") {
            throw new TypeError("The last argument must be a function");
        }
        try {
            const value = fn(...args);
            queueMicrotask(() => callback(null, value));
        } catch (err) {
            queueMicrotask(() => callback(err));
        }
    };
}

const api = {
    constants,
    Stats,
    Dirent,
    promises,

    readFile: callbackify((path, options) => sync.readFileSync(path, options)),
    writeFile: callbackify((path, data, options) => sync.writeFileSync(path, data, options)),
    appendFile: callbackify((path, data, options) => sync.appendFileSync(path, data, options)),
    stat: callbackify((path) => sync.statSync(path)),
    lstat: callbackify((path) => sync.lstatSync(path)),
    fstat: callbackify((fd) => sync.fstatSync(fd)),
    readdir: callbackify((path, options) => sync.readdirSync(path, options)),
    access: callbackify((path, mode) => sync.accessSync(path, mode)),
    mkdir: callbackify((path, options) => sync.mkdirSync(path, options)),
    rmdir: callbackify((path, options) => sync.rmdirSync(path, options)),
    rm: callbackify((path, options) => sync.rmSync(path, options)),
    unlink: callbackify((path) => sync.unlinkSync(path)),
    rename: callbackify((oldPath, newPath) => sync.renameSync(oldPath, newPath)),
    copyFile: callbackify((src, dest, mode) => sync.copyFileSync(src, dest, mode)),
    realpath: callbackify((path) => sync.realpathSync(path)),
    readlink: callbackify((path) => sync.readlinkSync(path)),
    symlink: callbackify((target, path) => sync.symlinkSync(target, path)),
    chmod: callbackify((path, mode) => sync.chmodSync(path, mode)),
    chown: callbackify((path, uid, gid) => sync.chownSync(path, uid, gid)),
    utimes: callbackify((path, atime, mtime) => sync.utimesSync(path, atime, mtime)),
    truncate: callbackify((path, len) => sync.truncateSync(path, len)),
    mkdtemp: callbackify((prefix) => sync.mkdtempSync(prefix)),
    statfs: callbackify((path) => sync.statfsSync(path)),

    readFileSync: sync.readFileSync,
    writeFileSync: sync.writeFileSync,
    appendFileSync: sync.appendFileSync,
    statSync: sync.statSync,
    lstatSync: sync.lstatSync,
    fstatSync: sync.fstatSync,
    readdirSync: sync.readdirSync,
    existsSync: sync.existsSync,
    accessSync: sync.accessSync,
    mkdirSync: sync.mkdirSync,
    rmdirSync: sync.rmdirSync,
    rmSync: sync.rmSync,
    unlinkSync: sync.unlinkSync,
    renameSync: sync.renameSync,
    copyFileSync: sync.copyFileSync,
    realpathSync: sync.realpathSync,
    readlinkSync: sync.readlinkSync,
    symlinkSync: sync.symlinkSync,
    chmodSync: sync.chmodSync,
    chownSync: sync.chownSync,
    utimesSync: sync.utimesSync,
    truncateSync: sync.truncateSync,
    mkdtempSync: sync.mkdtempSync,
    statfsSync: sync.statfsSync,

    // Streams/watch are wired in the dedicated modules.
    createReadStream: require("./streams.js").createReadStream,
    createWriteStream: require("./streams.js").createWriteStream,
    watch: require("./watcher.js").watch,
    watchFile: require("./watcher.js").watchFile,
    unwatchFile: require("./watcher.js").unwatchFile,
    FSWatcher: require("./watcher.js").FSWatcher,
    StatWatcher: require("./watcher.js").StatWatcher,
};

module.exports = api;
module.exports.default = api;
