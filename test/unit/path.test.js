"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const nodePath = require("node:path");
const path = require("../../js/builtins/path.js");

test("path facade mirrors node:path on POSIX", () => {
    assert.equal(path.sep, "/");
    assert.equal(path.delimiter, ":");
    assert.equal(path.posix, path);

    const values = ["", ".", "/", "/a/b.txt", "a/b/", "/a/b/", "index.js",
        "/a/.hidden", "a.b.c", "/a/b.c/", "//", "a//b"];
    for (const value of values) {
        assert.equal(path.normalize(value), nodePath.normalize(value), "normalize " + value);
        assert.equal(path.dirname(value), nodePath.dirname(value), "dirname " + value);
        assert.equal(path.basename(value), nodePath.basename(value), "basename " + value);
        assert.equal(path.extname(value), nodePath.extname(value), "extname " + value);
        assert.equal(path.isAbsolute(value), nodePath.isAbsolute(value), "isAbsolute " + value);
        assert.deepEqual(path.parse(value), nodePath.parse(value), "parse " + value);
    }

    const pairs = [["a", "b"], ["/a/b", "/a/c"], ["/a/b/", "/a/b"],
        ["a/b", "a/b/c"], [".", "."], ["c", "d/e"]];
    for (const [a, b] of pairs) {
        assert.equal(path.join(a, b), nodePath.join(a, b), "join " + a + "," + b);
        assert.equal(path.relative(a, b), nodePath.relative(a, b), "relative " + a + "," + b);
    }

    const parts = [{ dir: "/a", base: "b.txt" }, { base: "x" },
        { dir: "/a", name: "b", ext: ".c" }, { dir: "/a/", base: "b" }];
    for (const part of parts) {
        assert.equal(path.format(part), nodePath.format(part), "format " + JSON.stringify(part));
    }
});
