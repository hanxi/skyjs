"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("../../js/builtins/events.js");

test("EventEmitter on/emit/once/remove semantics", () => {
    const emitter = new EventEmitter();
    const seen = [];
    function onValue(value) { seen.push("on:" + value); }
    emitter.on("value", onValue);
    emitter.once("value", (value) => seen.push("once:" + value));
    assert.equal(emitter.emit("value", 1), true);
    emitter.emit("value", 2);
    emitter.removeListener("value", onValue);
    assert.equal(emitter.emit("value", 3), false);
    assert.deepEqual(seen, ["on:1", "once:1", "on:2"]);
    assert.equal(emitter.listenerCount("value"), 0);
});
