"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("../../js/internal/buffer-core.js");

test("Buffer allocation, encodings, and zero initialization", () => {
    assert.deepEqual(Array.from(Buffer.allocUnsafe(4)), [0, 0, 0, 0]);
    assert.equal(Buffer.from("hello").toString("utf8"), "hello");
    assert.equal(Buffer.from("aGVsbG8=", "base64").toString(), "hello");
    assert.equal(Buffer.from("68656c6c6f", "hex").toString(), "hello");
    assert.equal(Buffer.byteLength("hello"), 5);
    assert.equal(Buffer.isEncoding("utf8"), true);
    assert.equal(Buffer.isEncoding("nope"), false);
    assert.equal(Buffer.compare(Buffer.from("a"), Buffer.from("b")), -1);
});
