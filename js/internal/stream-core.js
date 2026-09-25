"use strict";

// Credit-based stream kernel shared by every facade (require('stream'),
// fs/net/http/subprocess). Chunks are always ArrayBuffer (binary-first); text
// is decoded by upper layers.
//
// Two shapes:
//   readable(source) -> Readable   pull(n) -> Promise<ArrayBuffer|null>
//   writable(sink)   -> Writable   write(ab), close(), abort(reason)
// The Node classes in builtins/stream/ adapt these; they never re-implement
// flow control (node-compatibility §16.6).

const DEFAULT_HIGH_WATER_MARK = 1024 * 1024; // 1 MiB

function toArrayBuffer(chunk) {
    if (chunk === null || chunk === undefined) return null;
    if (chunk instanceof ArrayBuffer) return chunk;
    if (ArrayBuffer.isView(chunk)) {
        return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    }
    if (typeof chunk === "string") {
        return new TextEncoder().encode(chunk).buffer;
    }
    throw new TypeError("stream chunk must be ArrayBuffer, view, or string");
}

function streamError(message, code) {
    const err = new Error(message);
    err.code = code || "ERR_STREAM";
    err.detail = { skyjsCode: code || "ERR_INTERNAL" };
    return err;
}

function abortedError(reason) {
    const err = reason instanceof Error ? reason : new Error(
        reason === undefined ? "The operation was aborted" : String(reason));
    if (err.name !== "AbortError" && err.code === undefined) {
        err.name = "AbortError";
        err.code = "ABORT_ERR";
        err.detail = { skyjsCode: "ERR_CANCELLED" };
    }
    return err;
}

/** Async queue used to bridge pull()/write() promises. */
class AsyncQueue {
    constructor() {
        this._items = [];
        this._waiter = null;
    }

    push(item) {
        if (this._waiter !== null) {
            const waiter = this._waiter;
            this._waiter = null;
            waiter(item);
        } else {
            this._items.push(item);
        }
    }

    shift() {
        if (this._items.length > 0) return Promise.resolve(this._items.shift());
        return new Promise((resolve) => { this._waiter = resolve; });
    }

    get size() {
        return this._items.length;
    }
}

// ---------------------------------------------------------------- readable

class Readable {
    constructor(source) {
        if (source === null || typeof source !== "object") {
            throw new TypeError("readable(source): source object required");
        }
        if (typeof source.pull !== "function") {
            throw new TypeError("readable(source): source.pull must be a function");
        }
        this._pull = source.pull;
        this._cancel = typeof source.cancel === "function" ? source.cancel : null;
        this._highWaterMark = source.highWaterMark || DEFAULT_HIGH_WATER_MARK;
        this._closed = false;
        this._ended = false;
        this._error = null;
        this._pumping = false;
        this._buffer = new AsyncQueue();
        this._bufferedBytes = 0;
    }

    get closed() {
        return this._closed || this._ended;
    }

    get highWaterMark() {
        return this._highWaterMark;
    }

    /** Read up to `n` bytes, or the whole buffered chunk when n is undefined. */
    async read(n) {
        if (this._error !== null) throw this._error;
        if (this._ended && this._buffer.size === 0) return null;
        if (this._buffer.size === 0) await this._pump();
        if (this._error !== null) throw this._error;
        if (this._buffer.size === 0 && this._ended) return null;
        const chunk = await this._buffer.shift();
        if (chunk === null) return null;
        this._bufferedBytes -= chunk.byteLength;
        if (n !== undefined && n >= 0 && chunk.byteLength > n) {
            this._buffer.push(chunk.slice(n));
            this._bufferedBytes += chunk.byteLength - n;
            return chunk.slice(0, n);
        }
        return chunk;
    }

    async _pump() {
        if (this._pumping || this._ended || this._error !== null) return;
        this._pumping = true;
        try {
            const chunk = await this._pull(this._highWaterMark, { readable: this });
            if (chunk === null || chunk === undefined) {
                this._ended = true;
            } else {
                const buffer = toArrayBuffer(chunk);
                this._buffer.push(buffer);
                this._bufferedBytes += buffer.byteLength;
            }
        } catch (err) {
            this._error = err;
        } finally {
            this._pumping = false;
        }
    }

    async *iterator() {
        for (;;) {
            const chunk = await this.read();
            if (chunk === null) return;
            yield chunk;
        }
    }

    async pipe(writable, opts) {
        return pipe(this, writable, opts);
    }

    async cancel(reason) {
        if (this._cancel !== null) await this._cancel(reason);
        this._closed = true;
        this._ended = true;
    }
}

function readable(source) {
    return new Readable(source);
}

// ---------------------------------------------------------------- writable

class Writable {
    constructor(sink) {
        if (sink === null || typeof sink !== "object") {
            throw new TypeError("writable(sink): sink object required");
        }
        if (typeof sink.write !== "function") {
            throw new TypeError("writable(sink): sink.write must be a function");
        }
        this._write = sink.write;
        this._close = typeof sink.close === "function" ? sink.close : null;
        this._abort = typeof sink.abort === "function" ? sink.abort : null;
        this._highWaterMark = sink.highWaterMark || DEFAULT_HIGH_WATER_MARK;
        this._pending = 0;
        this._closed = false;
        this._error = null;
        this._tail = Promise.resolve();
    }

    get needDrain() {
        return this._pending >= this._highWaterMark;
    }

    get closed() {
        return this._closed;
    }

    /** Resolves when the sink accepted the chunk (backpressure otherwise). */
    write(chunk) {
        if (this._closed) {
            return Promise.reject(streamError("write after end", "ERR_STREAM_WRITE_AFTER_END"));
        }
        if (this._error !== null) return Promise.reject(this._error);
        const buffer = toArrayBuffer(chunk);
        this._pending += buffer.byteLength;
        const run = this._tail.then(() => this._write(buffer, { writable: this }));
        this._tail = run.then(() => {}, () => {});
        return run.then(
            () => { this._pending -= buffer.byteLength; },
            (err) => {
                this._pending -= buffer.byteLength;
                this._error = err;
                throw err;
            });
    }

    async end() {
        if (this._closed) return;
        await this._tail;
        this._closed = true;
        if (this._close !== null) await this._close();
    }

    async abort(reason) {
        if (this._closed) return;
        this._closed = true;
        this._error = abortedError(reason);
        if (this._abort !== null) await this._abort(this._error);
    }
}

function writable(sink) {
    return new Writable(sink);
}

// ------------------------------------------------------------- pipe/combine

/** Pump a Readable into a Writable with credit-based backpressure. */
async function pipe(source, sink, opts) {
    const options = opts || {};
    const signal = options.signal;
    const end = options.end !== false;
    try {
        for (;;) {
            if (signal && signal.aborted) throw abortedError(signal.reason);
            const chunk = await source.read();
            if (chunk === null) break;
            await sink.write(chunk);
        }
        if (end) await sink.end();
    } catch (err) {
        await source.cancel(err);
        await sink.abort(err);
        throw err;
    }
}

/** Run stages sequentially: readable -> transform(s) -> writable. */
async function pipeline(...args) {
    if (args.length < 2) {
        throw new TypeError("pipeline requires at least a source and a destination");
    }
    let options = {};
    if (args.length > 2 && typeof args[args.length - 1] === "object" &&
        args[args.length - 1] !== null && args[args.length - 1]._writable !== true) {
        const maybe = args[args.length - 1];
        if (maybe.signal !== undefined || maybe.timeoutMs !== undefined) {
            options = maybe;
            args = args.slice(0, -1);
        }
    }
    const timeoutMs = options.timeoutMs;
    let timer = null;
    if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
            if (timer !== null) timer = "fired";
        }, timeoutMs);
    }
    try {
        for (let i = 0; i < args.length - 1; i++) {
            const isLast = i === args.length - 2;
            await pipe(args[i], args[i + 1], {
                signal: options.signal,
                end: true,
            });
            if (!isLast) {
                // passed through a transform; the next pipe continues from it
            }
        }
    } finally {
        if (timer !== null && timer !== "fired") clearTimeout(timer);
    }
}

module.exports = {
    DEFAULT_HIGH_WATER_MARK,
    READABLE: Symbol("skyjs.stream.readable"),
    WRITABLE: Symbol("skyjs.stream.writable"),
    readable,
    writable,
    pipe,
    pipeline,
    Readable,
    Writable,
    AsyncQueue,
    toArrayBuffer,
};
