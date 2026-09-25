"use strict";

// fs.createReadStream / createWriteStream over internal/stream-core + fs-sync.

const stream = require("../stream/index.js");
const sync = require("../../internal/fs-sync.js");
const fsCore = require("../../internal/fs-core.js");

const DEFAULT_CHUNK = 64 * 1024;

class ReadStream extends stream.Readable {
    constructor(path, options) {
        const opts = options || {};
        super({ highWaterMark: opts.highWaterMark || DEFAULT_CHUNK });
        this.path = path;
        this.bytesRead = 0;
        this._position = opts.start === undefined ? 0 : Number(opts.start);
        this._end = opts.end === undefined ? Infinity : Number(opts.end);
        try {
            this._data = Buffer.from(fsCore.readFile(path));
            this._handle = null;
        } catch (err) {
            this._error = err;
        }
        this.emit("open", 0);
        this.emit("ready");
    }

    _read() {
        if (this._error) {
            this.emit("error", this._error);
            return;
        }
        let chunk = null;
        if (this._position <= this._end && this._position < this._data.length) {
            const end = Math.min(this._data.length - 1, this._end);
            chunk = this._data.subarray(this._position, end + 1);
            this._position += chunk.length;
            this.bytesRead += chunk.length;
        }
        if (chunk === null) {
            this.push(null);
            this.emit("close");
            return;
        }
        this.push(chunk);
    }
}

class WriteStream extends stream.Writable {
    constructor(path, options) {
        const opts = options || {};
        super({ highWaterMark: opts.highWaterMark || DEFAULT_CHUNK });
        this.path = path;
        this.bytesWritten = 0;
        this._chunks = [];
        this._flags = opts.flags || "w";
        this._mode = opts.mode;
        this.emit("open", 0);
        this.emit("ready");
    }

    _write(chunk, encoding, callback) {
        try {
            const buffer = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
            this._chunks.push(buffer);
            this.bytesWritten += buffer.length;
            callback();
        } catch (err) {
            callback(err);
        }
    }

    _finish(err) {
        if (!err) {
            try {
                const data = Buffer.concat(this._chunks);
                if (this._flags === "a") sync.appendFileSync(this.path, data);
                else sync.writeFileSync(this.path, data);
            } catch (writeErr) {
                err = writeErr;
            }
        }
        stream.Writable.prototype._finish.call(this, err);
    }
}

function createReadStream(path, options) {
    return new ReadStream(path, options);
}

function createWriteStream(path, options) {
    return new WriteStream(path, options);
}

module.exports = { createReadStream, createWriteStream, ReadStream, WriteStream };
