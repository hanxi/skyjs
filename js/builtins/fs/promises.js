"use strict";

// `fs/promises`: Promise forms over internal/fs-sync.

const sync = require("../../internal/fs-sync.js");
const constants = require("./constants.js");
const { Stats, Dirent } = require("./stats.js");

function promisify(fn) {
    return (...args) => new Promise((resolve, reject) => {
        try {
            resolve(fn(...args));
        } catch (err) {
            reject(err);
        }
    });
}

const api = {
    constants,
    Stats,
    Dirent,
    readFile: promisify((path, options) => sync.readFileSync(path, options)),
    writeFile: promisify((path, data, options) => sync.writeFileSync(path, data, options)),
    appendFile: promisify((path, data, options) => sync.appendFileSync(path, data, options)),
    stat: promisify((path) => sync.statSync(path)),
    lstat: promisify((path) => sync.lstatSync(path)),
    readdir: promisify((path, options) => sync.readdirSync(path, options)),
    access: promisify((path, mode) => sync.accessSync(path, mode)),
    mkdir: promisify((path, options) => sync.mkdirSync(path, options)),
    rmdir: promisify((path, options) => sync.rmdirSync(path, options)),
    rm: promisify((path, options) => sync.rmSync(path, options)),
    unlink: promisify((path) => sync.unlinkSync(path)),
    rename: promisify((oldPath, newPath) => sync.renameSync(oldPath, newPath)),
    copyFile: promisify((src, dest, mode) => sync.copyFileSync(src, dest, mode)),
    realpath: promisify((path) => sync.realpathSync(path)),
    readlink: promisify((path) => sync.readlinkSync(path)),
    symlink: promisify((target, path) => sync.symlinkSync(target, path)),
    chmod: promisify((path, mode) => sync.chmodSync(path, mode)),
    chown: promisify((path, uid, gid) => sync.chownSync(path, uid, gid)),
    utimes: promisify((path, atime, mtime) => sync.utimesSync(path, atime, mtime)),
    truncate: promisify((path, len) => sync.truncateSync(path, len)),
    mkdtemp: promisify((prefix) => sync.mkdtempSync(prefix)),
    statfs: promisify((path) => sync.statfsSync(path)),
};

module.exports = api;
