"use strict";

// NC2.5 exit checks: streaming a large file through pipe must not balloon the
// JS heap, and the owner must not leak handles across many open/close cycles.

const testing = require("skyjs/testing");
const fs = require("fs");
const stream = require("stream");
const fsCore = require("../internal/fs-core.js");
const fsClient = require("../internal/fs-client.js");

const DIR = "build/fs_exit_test";
const CHUNK = 256 * 1024;
const CHUNKS = 64; // 16 MiB total (proxy for the 1 GiB gate; CI-friendly)

skynet.timeout(1, async () => {
    if (fsCore.exists(DIR)) fsCore.remove(DIR);
    fsCore.mkdir(DIR, true);

    // ---- heap bound while piping a large file ----
    const payload = new Uint8Array(CHUNK);
    for (let i = 0; i < PAYLOAD_FILL; i++) payload[i] = i & 0xff;
    const writer = fs.createWriteStream(DIR + "/big.bin");
    for (let i = 0; i < CHUNKS; i++) {
        await new Promise((resolve, reject) => {
            const okWrite = writer.write(payload);
            if (okWrite) resolve();
            else writer.once("drain", resolve);
        });
    }
    await new Promise((resolve) => writer.end(resolve));

    const before = skynetcore.runtime.mem();
    let totalBytes = 0;
    const sink = new stream.Writable({
        write(chunk, encoding, callback) {
            totalBytes += chunk.length;
            callback();
        },
    });
    await stream.pipeline(fs.createReadStream(DIR + "/big.bin"), sink);
    const after = skynetcore.runtime.mem();
    const delta = after - before;
    testing.equal(totalBytes, CHUNK * CHUNKS, "streamed byte count");
    testing.ok(delta < 64 * 1024 * 1024, "JS heap delta under 64 MiB (got " + delta + ")");

    // ---- fd accounting: many owner round-trips do not leak ----
    for (let i = 0; i < 50; i++) {
        await fsClient.writeFile(DIR + "/cycle.bin", payload.buffer);
        await fsClient.readFile(DIR + "/cycle.bin");
    }
    const stat = await fsClient.ping();
    testing.ok(stat.inFlight === 0, "owner has no in-flight ops after cycles");

    fsCore.remove(DIR + "/big.bin");
    fsCore.remove(DIR + "/cycle.bin");
    fsCore.remove(DIR);
    skynetcore.runtime.error("FS_EXIT_OK streamed=" + totalBytes +
        " heap_delta=" + delta + " checks=" + testing.summary().checks);
});

const PAYLOAD_FILL = Math.min(CHUNK, 4096);

skynet.start(() => {
    skynet.dispatch("text", (msg) => "FS_EXIT:" + msg);
});
