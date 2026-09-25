"use strict";

// NC1.4 acceptance: one service sends an ArrayBuffer to another through the
// frameEncode/frameDecode envelope (no base64) and gets it echoed back.

const testing = require("skyjs/testing");
const log = require("skyjs/log");
const frame = require("../internal/binary-frame.js");

const worker = skynet.newservice("snjs test/service/binary-frame-worker.js");
skynetcore.runtime.error("BINARY_FRAME_WORKER " + worker);

skynet.timeout(1, async () => {
    // 192 KiB of structured bytes; large enough to require real framing but
    // small enough for fast CI.
    const payload = new Uint8Array(192 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

    const request = frame.frameEncode({ op: "echo", len: payload.length, bodyLength: payload.length },
        payload.buffer);
    const reply = await skynet.call(worker, "lua", request);
    const { header, body } = frame.frameDecode(reply);
    const echoed = new Uint8Array(body);
    testing.equal(header.op, "echo", "header round-trip");
    testing.equal(echoed.length, payload.length, "echo length");
    let same = true;
    for (let i = 0; i < payload.length; i++) {
        if (payload[i] !== echoed[i]) { same = false; break; }
    }
    testing.ok(same, "byte-identical echo");
    log.info({ msg: "binary frame echo complete", bytes: echoed.length, checks: testing.summary().checks });
    skynetcore.runtime.error("BINARY_FRAME_OK bytes=" + echoed.length + " checks=" + testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "BINARY_FRAME:" + msg);
});
