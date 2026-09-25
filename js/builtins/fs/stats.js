"use strict";

// Node `fs.Stats` / `Dirent` wrappers over the C stat shape.

class Stats {
    constructor(raw) {
        this.dev = 0;
        this.ino = 0;
        this.mode = raw.mode;
        this.nlink = 1;
        this.uid = 0;
        this.gid = 0;
        this.rdev = 0;
        this.size = raw.size;
        this.blksize = 4096;
        this.blocks = Math.ceil(raw.size / 512);
        this.atimeMs = raw.mtime * 1000;
        this.mtimeMs = raw.mtime * 1000;
        this.ctimeMs = raw.mtime * 1000;
        this.birthtimeMs = raw.mtime * 1000;
        this.atime = new Date(this.atimeMs);
        this.mtime = new Date(this.mtimeMs);
        this.ctime = new Date(this.ctimeMs);
        this.birthtime = new Date(this.birthtimeMs);
        this._raw = raw;
    }

    isFile() { return !!this._raw.isFile; }
    isDirectory() { return !!this._raw.isDir; }
    isSymbolicLink() { return !!this._raw.isSymbolicLink; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

class Dirent {
    constructor(name, raw) {
        this.name = name;
        this._raw = raw || {};
    }

    isFile() { return this._raw.isFile === true; }
    isDirectory() { return this._raw.isDir === true; }
    isSymbolicLink() { return this._raw.isSymbolicLink === true; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
}

module.exports = { Stats, Dirent };
