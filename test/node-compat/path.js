"use strict";

// Differential case: path semantics on POSIX. run() returns a JSON-comparable
// structure so both runtimes can be compared byte-for-byte.

module.exports.run = function () {
    const path = require("path");
    const inputs = ["", ".", "/", "/a/b.txt", "a/b/", "/a/b/", "index.js",
        "/a/.hidden", "a.b.c", "/a/b.c/", "//", "a//b"];
    const out = { normalize: {}, join: [], resolve: {}, relative: [], parse: {},
        format: [], dirname: {}, basename: {}, extname: {}, isAbsolute: {} };

    for (const value of inputs) {
        out.normalize[value] = path.normalize(value);
        out.parse[value] = path.parse(value);
        out.dirname[value] = path.dirname(value);
        out.basename[value] = path.basename(value);
        out.extname[value] = path.extname(value);
        out.isAbsolute[value] = path.isAbsolute(value);
    }
    const pairs = [["a", "b"], ["/a/b", "/a/c"], ["/a/b/", "/a/b"],
        ["a/b", "a/b/c"], [".", "."], ["c", "d/e"]];
    for (const [a, b] of pairs) {
        out.join.push([a, b, path.join(a, b)]);
        out.relative.push([a, b, path.relative(a, b)]);
    }
    const parts = [
        { dir: "/a", base: "b.txt", ext: ".txt", name: "b" },
        { dir: "", base: "x" },
        { dir: "/a", name: "b", ext: ".c" },
        { dir: "/a/", base: "b" },
        { base: "x" },
    ];
    for (const part of parts) out.format.push([part, path.format(part)]);

    out.sep = path.sep;
    out.delimiter = path.delimiter;
    return out;
};
