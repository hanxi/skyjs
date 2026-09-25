"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bf = require("../../js/internal/binary-frame.js");

test("binary-frame round-trips header and body", () => {
    const frame = bf.frameEncode({ op: "read", reqId: 7 }, new Uint8Array([1, 2, 3]));
    const { header, body } = bf.frameDecode(frame);
    assert.equal(header.op, "read");
    assert.equal(header.reqId, 7);
    assert.deepEqual(Array.from(new Uint8Array(body)), [1, 2, 3]);
    assert.equal(bf.frameDecode(bf.frameEncode({ op: "x" })).body, null);
});

test("binary-frame rejects malformed frames", () => {
    assert.throws(() => bf.frameDecode(new Uint8Array([1, 2])), /frame too short/);
    const bad = new Uint8Array(bf.frameEncode({ op: "x" }));
    bad[0] = 0;
    assert.throws(() => bf.frameDecode(bad), /bad frame magic/);
    const truncated = new Uint8Array(bf.frameEncode({ op: "x" }, new Uint8Array([1, 2, 3])));
    assert.throws(() => bf.frameDecode(truncated.subarray(0, truncated.length - 1)),
        /length mismatch/);
});

test("FrameDecoder frames a split and coalesced stream", () => {
    const a = new Uint8Array(bf.frameEncode({ op: "a" }, new Uint8Array([9])));
    const b = new Uint8Array(bf.frameEncode({ op: "b" }));
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a, 0);
    stream.set(b, a.length);

    const whole = new bf.FrameDecoder().push(stream);
    assert.equal(whole.length, 2);
    assert.equal(whole[0].header.op, "a");
    assert.equal(whole[1].header.op, "b");

    const split = new bf.FrameDecoder();
    assert.equal(split.push(stream.subarray(0, 5)).length, 0);
    assert.equal(split.push(stream.subarray(5)).length, 2);
});
