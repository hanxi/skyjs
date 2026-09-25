"use strict";

// Node `fs` sync operations implemented over the C primitives. This is the
// single implementation shared by fs (callback + sync + promises) and
// skyjs/fsx, mirroring the "one kernel, several facades" rule (§16.6).

const core = require("./fs-core.js");
const { Stats, Dirent } = require("../builtins/fs/stats.js");
const constants = require("../builtins/fs/constants.js");
const errors = require("./errors.js");

function wrapStat(raw) {
    return new Stats(raw);
}

function readFileSync(path, options) {
    const raw = core.readFile(path);
    const encoding = typeof options === "string" ? options : (options && options.encoding);
    if (encoding) return Buffer.from(raw).toString(encoding);
    return Buffer.from(raw);
}

function writeFileSync(path, data, options) {
    const encoding = typeof options === "string" ? options : (options && options.encoding);
    core.writeFile(path, toBytes(data, encoding));
}

function appendFileSync(path, data, options) {
    const encoding = typeof options === "string" ? options : (options && options.encoding);
    core.appendFile(path, toBytes(data, encoding));
}

function toBytes(data, encoding) {
    if (data instanceof ArrayBuffer) return data;
    if (ArrayBuffer.isView(data)) {
        return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    }
    return Buffer.from(String(data), encoding || "utf8").buffer.slice(0);
}

function statSync(path) {
    return wrapStat(core.stat(path));
}

function lstatSync(path) {
    return wrapStat(core.lstat(path));
}

function fstatSync(fd) {
    return wrapStat(core.fstat(fd));
}

function readdirSync(path, options) {
    const names = core.readdir(path);
    const withFileTypes = options && (options.withFileTypes === true ||
        (typeof options === "string" && options === "utf8" ? false : options.withFileTypes));
    if (withFileTypes) return names.map((name) => new Dirent(name, {}));
    return names;
}

function existsSync(path) {
    return core.exists(path);
}

function accessSync(path, mode) {
    if (!core.exists(path)) {
        throw errors.systemError("ENOENT", "access", path);
    }
}

function mkdirSync(path, options) {
    const recursive = options && (options === true || options.recursive === true);
    try {
        core.mkdir(path, recursive);
    } catch (err) {
        if (recursive && err && err.code === "EEXIST") return undefined;
        throw normalize(err, "mkdir", path);
    }
    return undefined;
}

function rmdirSync(path, options) {
    try {
        core.remove(path);
    } catch (err) {
        if (options && options.recursive) return undefined;
        throw normalize(err, "rmdir", path);
    }
}

function rmSync(path, options) {
    const opts = options || {};
    try {
        if (opts.force !== false && !core.exists(path)) return undefined;
        core.remove(path);
    } catch (err) {
        if (opts.force) return undefined;
        throw normalize(err, "rm", path);
    }
}

function unlinkSync(path) {
    try {
        core.remove(path);
    } catch (err) {
        throw normalize(err, "unlink", path);
    }
}

function renameSync(oldPath, newPath) {
    try {
        core.rename(oldPath, newPath);
    } catch (err) {
        throw normalize(err, "rename", oldPath);
    }
}

function copyFileSync(src, dest, mode) {
    const data = core.readFile(src);
    core.writeFile(dest, data);
}

function realpathSync(path) {
    return core.realpath(path);
}

function readlinkSync(path) {
    return core.readlink(path);
}

function symlinkSync(target, path) {
    return core.symlink(target, path);
}

function chmodSync(path, mode) {
    return core.chmod(path, mode);
}

function chownSync(path, uid, gid) {
    return core.chown(path, uid, gid);
}

function utimesSync(path, atime, mtime) {
    return core.utimes(path, atime, mtime);
}

function truncateSync(path, len) {
    const fd = core.open(path, "r+");
    try {
        core.ftruncate(fd, len);
    } finally {
        core.fclose(fd);
    }
}

function mkdtempSync(prefix) {
    return core.mkdtemp(prefix);
}

function statfsSync(path) {
    return core.statvfs(path);
}

function normalize(err, syscall, path) {
    if (err && typeof err.code === "string" && err.code.startsWith("E")) return err;
    return errors.normalizeError(err, { path, syscall });
}

module.exports = {
    constants,
    Stats,
    Dirent,
    readFileSync,
    writeFileSync,
    appendFileSync,
    statSync,
    lstatSync,
    fstatSync,
    readdirSync,
    existsSync,
    accessSync,
    mkdirSync,
    rmdirSync,
    rmSync,
    unlinkSync,
    renameSync,
    copyFileSync,
    realpathSync,
    readlinkSync,
    symlinkSync,
    chmodSync,
    chownSync,
    utimesSync,
    truncateSync,
    mkdtempSync,
    statfsSync,
    toBytes,
};
