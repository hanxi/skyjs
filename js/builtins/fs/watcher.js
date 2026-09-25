"use strict";

// fs.watch / watchFile. SkyJS has no native watcher yet (the kqueue/inotify
// thread lands with the .fs owner); these report availability explicitly rather
// than degrading silently into polling (node-compatibility §8, §12.1).

const { EventEmitter } = require("../events.js");
const errors = require("../../internal/errors.js");

class FSWatcher extends EventEmitter {
    constructor(filename, options) {
        super();
        this._filename = filename;
        this._options = options || {};
        this._closed = false;
    }
    close() {
        this._closed = true;
        this.emit("close");
    }
}

class StatWatcher extends EventEmitter {
    constructor() {
        super();
        this._closed = false;
    }
    close() {
        this._closed = true;
    }
}

function unsupported(syscall) {
    return errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
        "fs." + syscall + " is not implemented yet (native watcher lands with the .fs owner)");
}

function watch(filename, options, listener) {
    throw unsupported("watch");
}

function watchFile(filename, options, listener) {
    throw unsupported("watchFile");
}

function unwatchFile(filename, listener) {
    throw unsupported("unwatchFile");
}

module.exports = { watch, watchFile, unwatchFile, FSWatcher, StatWatcher };
