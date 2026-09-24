"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TextEncoder, TextDecoder } = require("../../js/internal/text-codec.js");

test("TextEncoder/TextDecoder UTF-8 round-trip", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8");
    const text = "hello 世界 \ud83d\ude00";
    const bytes = encoder.encode(text);
    assert.deepEqual(Array.from(bytes), Array.from(new globalThis.TextEncoder().encode(text)));
    assert.equal(decoder.decode(bytes), text);
});
