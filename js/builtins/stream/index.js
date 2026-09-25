"use strict";

// Node `stream` facade. Flow control lives in internal/stream-core.js; these
// classes adapt it to Node's EventEmitter API so engine facades (fs/net/http/
// subprocess) and user code share one implementation (node-compatibility §16.6).

const { EventEmitter } = require("../events.js");
const streamCore = require("../../internal/stream-core.js");
const errors = require("../../internal/errors.js");

const HIGH_WATER_MARK = 16 * 1024;

function toBuffer(chunk, encoding) {
    if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
    if (ArrayBuffer.isView(chunk)) {
        return Buffer.from(chunk.buffer.slice(chunk.byteOffset,
            chunk.byteOffset + chunk.byteLength));
    }
    return Buffer.from(String(chunk), encoding || "utf8");
}

// ------------------------------------------------------------------ readable

class Readable extends EventEmitter {
    constructor(options) {
        super();
        const opts = options || {};
        this._readableState = {
            objectMode: !!opts.objectMode,
            highWaterMark: opts.highWaterMark || HIGH_WATER_MARK,
            buffer: [],
            buffered: 0,
            flowing: false,
            ended: false,
            destroyed: false,
            reading: false,
        };
        this.readable = true;
        this._readFn = typeof opts.read === "function" ? opts.read :
            function () { this.push(null); };
    }

    _read() {
        this.push(null);
    }

    push(chunk, encoding) {
        const state = this._readableState;
        if (chunk === null) {
            state.ended = true;
            this._flush();
            this.emit("end");
            this.emit("close");
            return false;
        }
        const buffer = toBuffer(chunk, encoding);
        state.buffer.push(buffer);
        state.buffered += buffer.length;
        if (state.flowing) this._flush();
        return state.buffered < state.highWaterMark;
    }

    _flush() {
        const state = this._readableState;
        while (state.flowing && state.buffer.length > 0) {
            const chunk = state.buffer.shift();
            state.buffered -= chunk.length;
            this.emit("data", chunk);
        }
    }

    read(size) {
        const state = this._readableState;
        if (state.buffer.length === 0 && !state.ended) {
            this._readFn.call(this, size || state.highWaterMark);
        }
        if (state.buffer.length === 0) {
            if (state.ended) this.emit("end");
            return null;
        }
        const chunk = state.buffer.shift();
        state.buffered -= chunk.length;
        return chunk;
    }

    pipe(destination, options) {
        const opts = options || {};
        this.on("data", (chunk) => {
            if (destination.write) destination.write(chunk);
        });
        this.on("end", () => {
            if (opts.end !== false && destination.end) destination.end();
        });
        this.resume();
        return destination;
    }

    pause() {
        this._readableState.flowing = false;
        return this;
    }

    resume() {
        const state = this._readableState;
        state.flowing = true;
        if (state.buffer.length === 0 && !state.ended) {
            this._readFn.call(this, state.highWaterMark);
        }
        this._flush();
        return this;
    }

    isPaused() {
        return !this._readableState.flowing;
    }

    destroy() {
        this._readableState.destroyed = true;
        this.readable = false;
        this.emit("close");
        return this;
    }

    async *[Symbol.asyncIterator]() {
        for (;;) {
            const chunk = await this._readAsync();
            if (chunk === null) return;
            yield chunk;
        }
    }

    /**
     * Async read used by for-await: pumps the producer until a chunk is
     * buffered so the iterator cannot spin ahead of an async source.
     */
    async _readAsync() {
        const state = this._readableState;
        for (let spins = 0; state.buffer.length === 0 && !state.ended; spins++) {
            this._readFn.call(this, state.highWaterMark);
            if (state.buffer.length > 0 || state.ended) break;
            // Yield so the async producer can run; bail out after a bounded
            // number of turns to avoid a hot loop on an ended/empty stream.
            if (spins >= 1000) break;
            await new Promise((resolve) => queueMicrotask(resolve));
        }
        if (state.buffer.length === 0) {
            if (state.ended) this.emit("end");
            return null;
        }
        const chunk = state.buffer.shift();
        state.buffered -= chunk.length;
        return chunk;
    }

    static from(iterable, options) {
        const readable = new Readable(Object.assign({}, options, {
            read() { /* the async producer below pushes into the buffer */ },
        }));
        (async () => {
            try {
                for await (const chunk of iterable) {
                    readable.push(chunk);
                    await new Promise((resolve) => queueMicrotask(resolve));
                }
                readable.push(null);
            } catch (err) {
                readable.emit("error", err);
            }
        })();
        return readable;
    }
}

// ------------------------------------------------------------------ writable

/** Shared writable state/behaviour; mixed into Duplex/Transform. */
function initWritable(self, options) {
    const opts = options || {};
    self._writableState = {
        highWaterMark: opts.highWaterMark || HIGH_WATER_MARK,
        length: 0,
        ended: false,
        finished: false,
        destroyed: false,
    };
    self.writable = true;
    self._writeFn = typeof opts.write === "function" ? opts.write :
        function (chunk, encoding, callback) { callback(); };
    self._writableTail = Promise.resolve();
    self._writeError = null;
}

function writableWrite(self, chunk, encoding, callback) {
    let cb = callback;
    if (typeof encoding === "function") cb = encoding;
    const state = self._writableState;
    if (state.ended) {
        const err = errors.skyjsError("ERR_STREAM_WRITE_AFTER_END", "write after end");
        if (cb) cb(err); else self.emit("error", err);
        return false;
    }
    const buffer = toBuffer(chunk, encoding);
    state.length += buffer.length;
    // Serialize chunks so async sinks never interleave.
    const done = self._writableTail.then(() => new Promise((resolve) => {
        self._writeFn.call(self, buffer, "buffer", (err) => {
            state.length -= buffer.length;
            if (err) {
                self._writeError = err;
                self.emit("error", err);
            }
            resolve();
        });
    }));
    self._writableTail = done;
    if (cb === undefined) {
        return done.then(() => true, () => false);
    }
    done.then(() => {
        if (self._writeError) { cb(self._writeError); return; }
        cb();
        if (state.length === 0) self.emit("drain");
    }, () => {});
    return state.length < state.highWaterMark;
}

function writableEnd(self, chunk, encoding, callback) {
    let cb = callback;
    if (typeof encoding === "function") cb = encoding;
    if (chunk !== undefined && chunk !== null) self.write(chunk, encoding, () => {});
    const state = self._writableState;
    state.ended = true;
    self._writableTail.then(() => finishWritable(self, null),
        (err) => finishWritable(self, err));
    if (cb) self.once("finish", cb);
    return self;
}

function finishWritable(self, err) {
    const state = self._writableState;
    if (state.finished) return;
    state.finished = true;
    self._finish(err);
}

function writableFinish(self, err) {
    if (err) {
        self.emit("error", err);
    }
    self.emit("finish");
    self.emit("close");
}

function writableDestroy(self, err) {
    self._writableState.destroyed = true;
    self.writable = false;
    if (err) self.emit("error", err);
    self.emit("close");
    return self;
}

class Writable extends EventEmitter {
    constructor(options) {
        super();
        initWritable(this, options);
    }

    write(chunk, encoding, callback) {
        return writableWrite(this, chunk, encoding, callback);
    }

    end(chunk, encoding, callback) {
        return writableEnd(this, chunk, encoding, callback);
    }

    destroy(err) {
        return writableDestroy(this, err);
    }

    _finish(err) {
        writableFinish(this, err);
    }

    get writableEnded() {
        return this._writableState.ended;
    }

    get writableFinished() {
        return this._writableState.finished;
    }
}

// -------------------------------------------------------------------- duplex

class Duplex extends Readable {
    constructor(options) {
        super(options);
        initWritable(this, options);
        // A Duplex is driven by its writable side pushing; it must not end its
        // readable side merely because someone started reading.
        this._readFn = typeof (options || {}).read === "function" ?
            options.read : function () {};
    }

    write(chunk, encoding, callback) {
        return writableWrite(this, chunk, encoding, callback);
    }

    end(chunk, encoding, callback) {
        return writableEnd(this, chunk, encoding, callback);
    }

    destroy(err) {
        Readable.prototype.destroy.call(this);
        return writableDestroy(this, err);
    }

    get writableEnded() {
        return this._writableState.ended;
    }

    get writableFinished() {
        return this._writableState.finished;
    }
}

// ----------------------------------------------------------------- transform

class Transform extends Duplex {
    constructor(options) {
        const opts = Object.assign({}, options);
        const transformFn = opts.transform || function (chunk, encoding, callback) {
            callback(null, chunk);
        };
        opts.write = function (chunk, encoding, callback) {
            transformFn.call(this, chunk, encoding, (err, data) => {
                if (err) { callback(err); return; }
                if (data !== undefined && data !== null) this.push(data);
                callback();
            });
        };
        super(opts);
    }

    _finish(err) {
        // The readable side ends when the writable side finishes.
        Writable.prototype._finish.call(this, err);
        if (!err) this.push(null);
    }
}

class PassThrough extends Transform {
    constructor(options) {
        super(Object.assign({
            transform(chunk, encoding, callback) { callback(null, chunk); },
        }, options));
    }
}

class Stream extends EventEmitter {
    pipe(destination, options) {
        if (typeof this._pipeTo === "function") return this._pipeTo(destination, options);
        return destination;
    }
}

// ------------------------------------------------------------------ pipeline

/**
 * Node-style pipeline. Every hop is wired before pumping: sequencing hops one
 * at a time deadlocks, because a Transform emits "finish" on the writable side
 * before its readable side has drained.
 */
function pipeline(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
    const stages = args.filter((s) => s && typeof s === "object");
    const fail = (err) => {
        if (callback) callback(err);
        else throw err;
    };
    if (stages.length < 2) {
        const err = new TypeError("pipeline requires at least two streams");
        if (callback) { callback(err); return undefined; }
        return Promise.reject(err);
    }

    let settled = false;
    const promise = new Promise((resolve, reject) => {
        const settle = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err); else resolve();
        };
        for (const stage of stages) stage.on("error", settle);
        const last = stages[stages.length - 1];
        last.on("finish", () => settle());
        last.on("close", () => settle());
        for (let i = 0; i < stages.length - 1; i++) {
            stages[i].pipe(stages[i + 1]);
        }
    });

    if (callback) {
        promise.then(() => callback(), (err) => callback(err));
        return undefined;
    }
    return promise;
}

function finished(stream, callback) {
    if (typeof callback !== "function") {
        return new Promise((resolve, reject) => {
            finished(stream, (err) => err ? reject(err) : resolve());
        });
    }
    const state = stream._readableState;
    const wstate = stream._writableState;
    if ((state && state.ended) || (wstate && wstate.finished)) {
        callback();
        return undefined;
    }
    let done = false;
    const settle = (err) => {
        if (done) return;
        done = true;
        callback(err);
    };
    stream.on("end", () => settle());
    stream.on("finish", () => settle());
    stream.on("close", () => settle());
    stream.on("error", settle);
    return undefined;
}

module.exports = {
    Readable,
    Writable,
    Duplex,
    Transform,
    PassThrough,
    Stream,
    pipeline,
    finished,
    core: streamCore,
};
