"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeQs = require("node:querystring");
const qs = require("../../js/builtins/querystring.js");

test("querystring parse/stringify/escape mirror node:querystring", () => {
    const samples = ["", "a=1&b=2", "a=1&a=2", "a", "a=", "=b", "a=b=c",
        "x=%20%21", "a%5Bb%5D=1", "a=%E4%B8%AD"];
    for (const sample of samples) {
        assert.deepEqual({ ...qs.parse(sample) }, { ...nodeQs.parse(sample) },
            "parse " + sample);
    }
    const objects = [{ a: 1, b: "x" }, { a: ["1", "2"], b: "" },
        { a: undefined, b: 2 }, { "k k": "v v" }, { "!": "~" }, { a: null }];
    for (const object of objects) {
        assert.equal(qs.stringify(object), nodeQs.stringify(object),
            "stringify " + JSON.stringify(object));
    }
    for (const ch of " !'()~*abc/?#[]@$&+;=:%^`|{}<>\"\\") {
        assert.equal(qs.escape(ch), nodeQs.escape(ch), "escape " + ch);
    }
    assert.equal(qs.encode, qs.stringify);
    assert.equal(qs.decode, qs.parse);
});

test("querystring parse respects maxKeys", () => {
    const parsed = qs.parse("a=1&b=2&c=3", "&", "=", { maxKeys: 2 });
    assert.deepEqual(Object.keys(parsed), ["a", "b"]);
});
