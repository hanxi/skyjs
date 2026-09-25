"use strict";

// `require('buffer')` entry. Must be the same implementation as the global
// Buffer (see internal/buffer-core.js).

const core = require("../internal/buffer-core.js");

module.exports = {
    Buffer: core.Buffer,
    SlowBuffer: undefined,
    Blob: core.Blob,
    File: core.File,
    constants: core.constants,
    kMaxLength: core.kMaxLength,
    transcode: core.transcode,
    isAscii: core.isAscii,
    isUtf8: core.isUtf8,
};
