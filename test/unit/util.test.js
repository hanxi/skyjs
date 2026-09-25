"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeUtil = require("node:util");
const util = require("../../js/builtins/util.js");

test("util.format mirrors node:util", () => {
    const cases = [["%s-%d", "a", 3], ["%j", { a: 1 }], ["%%"], ["no fmt", 1, 2],
        ["%i", "12px"], ["%f", "1.5x"], ["extra", "a", "b"], ["hi", "a"],
        ["%s", "a", "b"], ["%d", "x"], [1, "a"], ["%o", [1, 2]], ["%s", null],
        ["%d", true]];
    for (const [format, ...args] of cases) {
        assert.equal(util.format(format, ...args), nodeUtil.format(format, ...args),
            JSON.stringify([format, ...args]));
    }
});

test("util.isDeepStrictEqual and types mirror node", () => {
    assert.equal(util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
    assert.equal(util.isDeepStrictEqual({ a: 1 }, { a: 2 }), false);
    assert.equal(util.isDeepStrictEqual(new Date(0), new Date(0)), true);
    assert.equal(util.isDeepStrictEqual({ a: undefined }, {}), false);
    assert.equal(util.types.isDate(new Date()), true);
    assert.equal(util.types.isTypedArray(new Uint8Array(1)), true);
    assert.equal(util.types.isTypedArray([]), false);
    assert.equal(util.getSystemErrorName(-2), "ENOENT");
    assert.equal(util.getSystemErrorName(-13), "EACCES");
});

test("util.promisify/callbackify round-trip", async () => {
    const nodeStyle = (value, cb) => queueMicrotask(() => cb(null, value * 2));
    const promised = util.promisify(nodeStyle);
    assert.equal(await promised(21), 42);

    const back = util.callbackify(async (value) => value + 1);
    const result = await new Promise((resolve, reject) =>
        back(41, (err, value) => err ? reject(err) : resolve(value)));
    assert.equal(result, 42);

    const failing = util.promisify((cb) => queueMicrotask(() => cb(new Error("boom"))));
    await assert.rejects(() => failing(), /boom/);
});
