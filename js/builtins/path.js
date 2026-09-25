"use strict";

// Node-compatible `path` facade over the shared POSIX path semantics in
// internal/path-posix.js. The loader uses that same internal module, so the
// two can never disagree; setCwd() is SkyJS-internal and not re-exported.

const posix = require("../internal/path-posix.js");

module.exports = {
    normalize: posix.normalize,
    join: posix.join,
    resolve: posix.resolve,
    isAbsolute: posix.isAbsolute,
    relative: posix.relative,
    dirname: posix.dirname,
    basename: posix.basename,
    extname: posix.extname,
    parse: posix.parse,
    format: posix.format,
    toNamespacedPath: posix.toNamespacedPath,
    sep: "/",
    delimiter: ":",
    win32: null,
};
module.exports.posix = module.exports;
