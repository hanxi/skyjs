"use strict";

// Node `zlib` facade over the skynetcore.crypt zlib primitives.

const errors = require("../internal/errors.js");

function toBuffer(data, encoding) {
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer.slice(data.byteOffset,
            data.byteOffset + data.byteLength));
    }
    return Buffer.from(String(data), encoding || "utf8");
}

function makeSync(name, primitive) {
    return function sync(data) {
        if (typeof skynetcore.crypt[primitive] !== "function") {
            throw errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
                "zlib primitive unavailable: " + primitive);
        }
        return Buffer.from(skynetcore.crypt[primitive](toBuffer(data)));
    };
}

function makeAsync(name, primitive) {
    const sync = makeSync(name, primitive);
    return function async(data, callback) {
        if (typeof callback === "function") {
            queueMicrotask(() => {
                try { callback(null, sync(data)); } catch (err) { callback(err); }
            });
            return undefined;
        }
        return new Promise((resolve) => resolve(sync(data)));
    };
}

const constantCharset = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");

module.exports = {
    constants: {
        Z_NO_FLUSH: 0, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4,
        Z_OK: 0, Z_STREAM_END: 1, Z_DEFAULT_COMPRESSION: -1,
        Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9,
        Z_DEFAULT_STRATEGY: 0, Z_FIXED: 4, Z_HUFFMAN_ONLY: 2, Z_RLE: 3,
        ZLIB_VERSION: "1.2.x",
        Z_MIN_WINDOWBITS: 8, Z_MAX_WINDOWBITS: 15,
    },
    deflateSync: makeSync("deflateSync", "deflate"),
    inflateSync: makeSync("inflateSync", "inflate"),
    gzipSync: makeSync("gzipSync", "gzip"),
    gunzipSync: makeSync("gunzipSync", "gunzip"),
    deflate: makeAsync("deflate", "deflate"),
    inflate: makeAsync("inflate", "inflate"),
    gzip: makeAsync("gzip", "gzip"),
    gunzip: makeAsync("gunzip", "gunzip"),
    createGzip: () => ({ _primitive: "gzip" }),
    createGunzip: () => ({ _primitive: "gunzip" }),
};
