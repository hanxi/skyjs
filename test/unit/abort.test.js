"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AbortController, AbortSignal } = require("../../js/internal/abort.js");

test("AbortController aborts once and notifies listeners", () => {
    const controller = new AbortController();
    let calls = 0;
    controller.signal.addEventListener("abort", () => { calls++; }, { once: true });
    controller.abort();
    controller.abort();
    assert.equal(controller.signal.aborted, true);
    assert.equal(calls, 1);
    assert.throws(() => controller.signal.throwIfAborted(), /aborted/);
    assert.equal(AbortSignal.abort().aborted, true);
});
