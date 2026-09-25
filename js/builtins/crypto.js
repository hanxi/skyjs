"use strict";

// Node `crypto` facade over internal/crypt-core (the same kernel as
// skyjs/crypt). Covers the common synchronous subset + randomUUID/randomBytes.

const crypt = require("../internal/crypt-core.js");
const { EventEmitter } = require("./events.js");

function toBuffer(data, encoding) {
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer.slice(data.byteOffset,
            data.byteOffset + data.byteLength));
    }
    return Buffer.from(String(data), encoding || "utf8");
}

function createHash(algorithm) {
    const algo = String(algorithm).toLowerCase().replace("-", "");
    const supported = { sha1: "sha1", sha256: "sha256", sha512: "sha512", md5: null };
    if (!(algo in supported)) {
        const err = new Error("Digest method not supported: " + algorithm);
        err.code = "ERR_CRYPTO_INVALID_DIGEST";
        throw err;
    }
    const parts = [];
    return {
        update(data, encoding) { parts.push(toBuffer(data, encoding)); return this; },
        digest(encoding) {
            const input = Buffer.concat(parts);
            let out;
            if (algo === "sha1") out = Buffer.from(crypt.sha1(input));
            else if (algo === "sha256") out = Buffer.from(crypt.sha256(input));
            else if (algo === "sha512") out = Buffer.from(crypt.sha512(input));
            else out = Buffer.from(crypt.hmacHash(Buffer.alloc(0), input));
            return encoding ? out.toString(encoding) : out;
        },
    };
}

function createHmac(algorithm, key) {
    const algo = String(algorithm).toLowerCase().replace("-", "");
    const keyBuffer = toBuffer(key);
    const parts = [];
    return {
        update(data, encoding) { parts.push(toBuffer(data, encoding)); return this; },
        digest(encoding) {
            const input = Buffer.concat(parts);
            let out;
            if (algo === "sha1") out = Buffer.from(crypt.hmacSha1(keyBuffer, input));
            else if (algo === "sha256") out = Buffer.from(crypt.hmacSha256(keyBuffer, input));
            else if (algo === "sha512") out = Buffer.from(crypt.hmacSha512(keyBuffer, input));
            else {
                const err = new Error("Digest method not supported: " + algorithm);
                err.code = "ERR_CRYPTO_INVALID_DIGEST";
                throw err;
            }
            return encoding ? out.toString(encoding) : out;
        },
    };
}

function randomBytes(size, callback) {
    const n = Number(size) | 0;
    const out = Buffer.from(crypt.randomBytes(n));
    if (typeof callback === "function") {
        queueMicrotask(() => callback(null, out));
        return undefined;
    }
    return out;
}

function randomUUID() {
    const bytes = new Uint8Array(crypt.randomBytes(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0"));
    return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" +
        hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" +
        hex.slice(10, 16).join("");
}

const timingSafeEqual = (a, b) => {
    const left = toBuffer(a);
    const right = toBuffer(b);
    if (left.length !== right.length) {
        throw new RangeError("Input buffers must have the same byte length");
    }
    let diff = 0;
    for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
    return diff === 0;
};

function getHashes() {
    return ["sha1", "sha256", "sha512"];
}

function getCiphers() {
    return skynetcore.crypt && skynetcore.crypt.aesGcmEncrypt ? ["aes-256-gcm"] : [];
}

module.exports = {
    createHash,
    createHmac,
    randomBytes,
    randomUUID,
    randomFillSync: (buffer) => {
        const bytes = new Uint8Array(crypt.randomBytes(buffer.length));
        if (buffer.set) buffer.set(bytes);
        else new Uint8Array(buffer).set(bytes);
        return buffer;
    },
    timingSafeEqual,
    getHashes,
    getCiphers,
    constants: { defaultCoreCipherList: "aes-256-gcm" },
};
