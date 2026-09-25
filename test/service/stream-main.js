"use strict";

// NC2.1 acceptance: require('stream') inside a real SkyJS service.

const testing = require("skyjs/testing");
const stream = require("stream");
const streamPromises = require("stream/promises");
const streamCore = require("../internal/stream-core.js");

skynet.timeout(1, async () => {
    // Node facade pipeline
    const output = [];
    await streamPromises.pipeline(
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
    testing.deepEqual(output, ["ALPHA", "BETA"], "pipeline output");

    // kernel backpressure + cancel
    let produced = 0;
    let cancelled = false;
    const source = streamCore.readable({
        pull() {
            if (produced >= 4) return null;
            produced++;
            return new Uint8Array([produced]).buffer;
        },
        cancel() { cancelled = true; },
    });
    const chunks = [];
    const sink = streamCore.writable({
        write(ab) {
            chunks.push(Array.from(new Uint8Array(ab)));
            return Promise.resolve();
        },
    });
    await streamCore.pipe(source, sink);
    testing.deepEqual(chunks, [[1], [2], [3], [4]], "kernel pipe");

    // async iterator
    const iterated = [];
    for await (const chunk of stream.Readable.from(["x", "y"])) {
        iterated.push(chunk.toString());
    }
    testing.deepEqual(iterated, ["x", "y"], "async iterator");

    skynetcore.runtime.error("STREAM_OK node=1 kernel=1 iterator=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "STREAM:" + msg);
});
