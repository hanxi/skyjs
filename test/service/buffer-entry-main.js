"use strict";

const buffer = require("buffer");

if (buffer.Buffer !== Buffer) {
    throw new Error("require('buffer').Buffer is not the global Buffer");
}
if (buffer.Blob !== Blob || buffer.File !== File) {
    throw new Error("require('buffer') Blob/File are not the globals");
}
if (typeof globalThis.Blob !== "function" || typeof globalThis.File !== "function") {
    throw new Error("Blob/File globals are missing");
}

const from = buffer.Buffer.from("hello");
if (from.toString("utf8") !== "hello") throw new Error("Buffer.from round-trip failed");
if (buffer.Buffer.allocUnsafe(4).join(",") !== "0,0,0,0") {
    throw new Error("allocUnsafe is not zero-initialized");
}
if (buffer.kMaxLength !== buffer.Buffer.kMaxLength) {
    throw new Error("kMaxLength mismatch");
}
if (typeof buffer.constants.MAX_LENGTH !== "number") {
    throw new Error("buffer.constants missing");
}
if (buffer.isAscii(buffer.Buffer.from("abc")) !== true ||
        buffer.isAscii(buffer.Buffer.from([0xff])) !== false) {
    throw new Error("isAscii failed");
}
if (buffer.isUtf8(buffer.Buffer.from("中文")) !== true ||
        buffer.isUtf8(buffer.Buffer.from([0xff])) !== false) {
    throw new Error("isUtf8 failed");
}
try {
    buffer.transcode();
    throw new Error("transcode should throw");
} catch (err) {
    if (err.code !== "ERR_UNSUPPORTED_PLATFORM") throw err;
}

skynetcore.runtime.error("BUFFER_ENTRY_OK buffer=1 blob=1 file=1");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "BUFFER:" + msg);
});
