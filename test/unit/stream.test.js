"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const stream = require("../../js/builtins/stream/index.js");
const streamCore = require("../../js/internal/stream-core.js");

test("kernel readable/writable pipe with backpressure", async () => {
    let produced = 0;
    const source = streamCore.readable({
        pull() {
            if (produced >= 3) return null;
            produced++;
            return new Uint8Array([produced]).buffer;
        },
    });
    const chunks = [];
    let maxPending = 0;
    const sink = streamCore.writable({
        write(ab) {
            maxPending = Math.max(maxPending, sink.needDrain ? 1 : 0);
            chunks.push(Array.from(new Uint8Array(ab)));
            return Promise.resolve();
        },
    });
    await streamCore.pipe(source, sink);
    assert.deepEqual(chunks, [[1], [2], [3]]);
    assert.equal(source.closed, true);
});

test("kernel propagates cancel/abort to both ends", async () => {
    let cancelled = null;
    let aborted = null;
    const source = streamCore.readable({
        pull() { return Promise.reject(new Error("boom")); },
        cancel(reason) { cancelled = reason; },
    });
    const sink = streamCore.writable({
        write() { return Promise.resolve(); },
        abort(reason) { aborted = reason; },
    });
    await assert.rejects(() => streamCore.pipe(source, sink), /boom/);
    assert.ok(cancelled instanceof Error);
    assert.ok(aborted instanceof Error);
});

test("Node Readable/Writable/Transform pipeline", async () => {
    const output = [];
    await stream.pipeline(
        stream.Readable.from(["alpha", "beta"]),
        new stream.Transform({
            transform(chunk, encoding, callback) {
                callback(null, Buffer.from(chunk.toString().toUpperCase()));
            },
        }),
        new stream.Writable({
            write(chunk, encoding, callback) {
                output.push(chunk.toString());
                callback();
            },
        }),
    );
    assert.deepEqual(output, ["ALPHA", "BETA"]);
});

test("stream errors propagate through pipeline", async () => {
    const failing = new stream.Transform({
        transform(chunk, encoding, callback) { callback(new Error("kaboom")); },
    });
    await assert.rejects(
        () => stream.pipeline(stream.Readable.from(["x"]), failing,
            new stream.Writable({ write(c, e, cb) { cb(); } })),
        /kaboom/);
});

test("async iterator and finished()", async () => {
    const chunks = [];
    for await (const chunk of stream.Readable.from(["p", "q"])) {
        chunks.push(chunk.toString());
    }
    assert.deepEqual(chunks, ["p", "q"]);

    const writable = new stream.Writable({
        write(chunk, encoding, callback) { queueMicrotask(callback); },
    });
    const done = stream.finished(writable);
    writable.end("z");
    await done;
    assert.equal(writable.writableFinished, true);
});
