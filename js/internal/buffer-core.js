"use strict";

// Node-compatible Buffer core. The full read/write/encoding surface lands in
// NC1; NC0 provides the globally exposed constructor and the safe allocation
// primitives used by the runtime.

const kMaxLength = 0x7fffffff;
const poolSize = 8192;
const textCodec = require("./text-codec.js");
const utf8Encoder = new textCodec.TextEncoder();
const utf8Decoder = new textCodec.TextDecoder("utf-8");

function coerceNumber(value, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
        throw new TypeError(name + " must be a non-negative integer");
    }
    return n;
}

function encodingsFor(input) {
    if (typeof input === "number") return null;
    if (typeof input === "string") return { encoding: "utf8" };
    if (input instanceof ArrayBuffer) return null;
    if (ArrayBuffer.isView(input)) return null;
    if (Array.isArray(input)) return null;
    if (input === null || input === undefined) {
        throw new TypeError("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array");
    }
    if (typeof input === "object" && !(input instanceof Uint8Array)) {
        return null;
    }
    return null;
}

function hexEncode(bytes) {
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
}

function hexDecode(text) {
    if (text.length % 2 !== 0) return null;
    const out = new Uint8Array(text.length / 2);
    for (let i = 0; i < out.length; i++) {
        const byte = parseInt(text.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) return null;
        out[i] = byte;
    }
    return out;
}

function base64Encode(bytes) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += chars[a >> 2];
        out += chars[((a & 3) << 4) | (b >> 4)];
        out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
        out += i + 2 < bytes.length ? chars[c & 63] : "=";
    }
    return out;
}

function base64Decode(text) {
    const clean = String(text).replace(/[\r\n\s]/g, "");
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const out = [];
    let bits = 0;
    let value = 0;
    for (const ch of clean) {
        if (ch === "=") break;
        const index = chars.indexOf(ch);
        if (index < 0) return null;
        value = (value << 6) | index;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((value >> bits) & 0xff);
        }
    }
    return new Uint8Array(out);
}

function encodeString(text, encoding) {
    const enc = (encoding || "utf8").toLowerCase().replace("-", "");
    if (enc === "utf8" || enc === "utf") return utf8Encoder.encode(text);
    if (enc === "hex") {
        const bytes = hexDecode(text);
        if (bytes === null) throw new TypeError("Invalid hex string");
        return bytes;
    }
    if (enc === "base64") {
        const bytes = base64Decode(text);
        if (bytes === null) throw new TypeError("Invalid base64 string");
        return bytes;
    }
    if (enc === "ascii" || enc === "latin1" || enc === "binary") {
        const out = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
        return out;
    }
    if (enc === "utf16le" || enc === "ucs2") {
        const out = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            out[i * 2] = text.charCodeAt(i) & 0xff;
            out[i * 2 + 1] = text.charCodeAt(i) >> 8;
        }
        return out;
    }
    throw new TypeError("Unknown encoding: " + encoding);
}

function decodeString(bytes, encoding) {
    const enc = (encoding || "utf8").toLowerCase().replace("-", "");
    if (enc === "utf8" || enc === "utf") return utf8Decoder.decode(bytes);
    if (enc === "hex") return hexEncode(bytes);
    if (enc === "base64") return base64Encode(bytes);
    if (enc === "ascii" || enc === "latin1" || enc === "binary") {
        let out = "";
        for (const byte of bytes) out += String.fromCharCode(byte);
        return out;
    }
    if (enc === "utf16le" || enc === "ucs2") {
        let out = "";
        for (let i = 0; i + 1 < bytes.length; i += 2) {
            out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
        }
        return out;
    }
    throw new TypeError("Unknown encoding: " + encoding);
}

class Buffer extends Uint8Array {
    constructor(value, encodingOrOffset, length) {
        if (typeof value === "number") {
            super(coerceNumber(value, "size"));
            return;
        }
        if (typeof value === "string") {
            const encoded = encodeString(value, encodingOrOffset || "utf8");
            super(encoded.length);
            this.set(encoded);
            return;
        }
        if (value instanceof ArrayBuffer) {
            const offset = encodingOrOffset === undefined ? 0 : coerceNumber(encodingOrOffset, "offset");
            const size = length === undefined ? value.byteLength - offset : coerceNumber(length, "length");
            super(value, offset, size);
            return;
        }
        if (ArrayBuffer.isView(value)) {
            super(value.buffer, value.byteOffset, value.byteLength);
            return;
        }
        if (Array.isArray(value)) {
            super(value.length);
            this.set(value);
            return;
        }
        encodingsFor(value);
        super(0);
    }

    static from(value, encodingOrOffset, length) {
        return new Buffer(value, encodingOrOffset, length);
    }

    static alloc(size, fill, encoding) {
        const bytes = new Buffer(coerceNumber(size, "size"));
        if (fill !== undefined) bytes.fill(fill, 0, bytes.length, encoding);
        return bytes;
    }

    static allocUnsafe(size) {
        // ND-8: zero-initialized until a security review explicitly changes it.
        return new Buffer(coerceNumber(size, "size"));
    }

    static allocUnsafeSlow(size) {
        return Buffer.allocUnsafe(size);
    }

    static byteLength(value, encoding) {
        if (typeof value === "string") return encodeString(value, encoding).length;
        if (value instanceof ArrayBuffer) return value.byteLength;
        if (ArrayBuffer.isView(value)) return value.byteLength;
        throw new TypeError("value must be a string, ArrayBuffer, or ArrayBufferView");
    }

    static isBuffer(value) {
        return value instanceof Buffer;
    }

    static isEncoding(encoding) {
        try {
            const enc = String(encoding).toLowerCase().replace("-", "");
            return ["utf8", "utf", "hex", "base64", "ascii", "latin1",
                "binary", "utf16le", "ucs2"].includes(enc);
        } catch (err) {
            return false;
        }
    }

    static compare(a, b) {
        const left = Buffer.from(a);
        const right = Buffer.from(b);
        const n = Math.min(left.length, right.length);
        for (let i = 0; i < n; i++) {
            if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
        }
        if (left.length === right.length) return 0;
        return left.length < right.length ? -1 : 1;
    }

    static concat(list, totalLength) {
        const chunks = list.map((item) => Buffer.from(item));
        const length = totalLength === undefined ?
            chunks.reduce((sum, item) => sum + item.length, 0) : totalLength;
        const out = Buffer.allocUnsafe(length);
        let offset = 0;
        for (const chunk of chunks) {
            if (offset >= length) break;
            out.set(chunk.subarray(0, length - offset), offset);
            offset += chunk.length;
        }
        return out;
    }

    toString(encoding, start, end) {
        return decodeString(this.subarray(start || 0, end === undefined ? this.length : end),
            encoding || "utf8");
    }

    equals(other) {
        const bytes = Buffer.from(other);
        if (this.length !== bytes.length) return false;
        for (let i = 0; i < this.length; i++) {
            if (this[i] !== bytes[i]) return false;
        }
        return true;
    }

    compare(other) {
        return Buffer.compare(this, other);
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
        const dest = target instanceof Uint8Array ? target :
            new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
        const start = sourceStart || 0;
        const end = sourceEnd === undefined ? this.length : sourceEnd;
        const chunk = this.subarray(start, end);
        dest.set(chunk.subarray(0, dest.length - (targetStart || 0)), targetStart || 0);
        return Math.max(0, Math.min(chunk.length, dest.length - (targetStart || 0)));
    }

    write(string, offset, length, encoding) {
        let off = offset;
        let len = length;
        let enc = encoding;
        if (typeof off === "string") { enc = off; off = 0; len = this.length; }
        else if (typeof len === "string") { enc = len; len = this.length; }
        if (off === undefined) off = 0;
        const bytes = encodeString(String(string), enc || "utf8");
        const count = Math.min(bytes.length, len === undefined ? this.length - off : len);
        this.set(bytes.subarray(0, count), off);
        return count;
    }
}

Object.defineProperty(Buffer, "kMaxLength", { value: kMaxLength });
Object.defineProperty(Buffer, "poolSize", {
    configurable: true, enumerable: true, writable: true, value: poolSize,
});

const constants = Object.freeze({
    MAX_LENGTH: kMaxLength,
    MAX_STRING_LENGTH: 0x1fffffe8,
    MAX_SAFE_INTEGER: 9007199254740991,
});

// ---- Blob / File (WHATWG subset used by fs.openAsBlob) --------------------

class Blob {
    constructor(parts, options) {
        const chunks = [];
        let size = 0;
        for (const part of (parts || [])) {
            let bytes;
            if (part instanceof Blob) {
                bytes = new Uint8Array(part._bytes);
            } else if (typeof part === "string") {
                bytes = utf8Encoder.encode(part);
            } else if (part instanceof ArrayBuffer) {
                bytes = new Uint8Array(part.slice(0));
            } else if (ArrayBuffer.isView(part)) {
                bytes = new Uint8Array(part.buffer.slice(
                    part.byteOffset, part.byteOffset + part.byteLength));
            } else {
                bytes = utf8Encoder.encode(String(part));
            }
            chunks.push(bytes);
            size += bytes.length;
        }
        this._bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            this._bytes.set(chunk, offset);
            offset += chunk.length;
        }
        this.size = size;
        this.type = options && options.type ? String(options.type).toLowerCase() : "";
    }

    arrayBuffer() {
        return Promise.resolve(this._bytes.buffer.slice(0));
    }

    text() {
        return Promise.resolve(utf8Decoder.decode(this._bytes));
    }

    bytes() {
        return Promise.resolve(new Uint8Array(this._bytes));
    }

    slice(start, end, type) {
        const from = start === undefined ? 0 : (start < 0 ? Math.max(this.size + start, 0) : Math.min(start, this.size));
        const to = end === undefined ? this.size : (end < 0 ? Math.max(this.size + end, 0) : Math.min(end, this.size));
        return new Blob([this._bytes.slice(from, to)], { type: type === undefined ? this.type : type });
    }

    get [Symbol.toStringTag]() {
        return "Blob";
    }
}

class File extends Blob {
    constructor(parts, name, options) {
        super(parts, options);
        this.name = String(name);
        this.lastModified = options && options.lastModified !== undefined ?
            Number(options.lastModified) : Date.now();
    }

    get [Symbol.toStringTag]() {
        return "File";
    }
}

function transcode() {
    const err = new Error("buffer.transcode() is not supported (no ICU)");
    err.code = "ERR_UNSUPPORTED_PLATFORM";
    err.detail = { skyjsCode: "ERR_UNSUPPORTED_PLATFORM" };
    throw err;
}

function isAscii(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    for (const byte of bytes) {
        if (byte > 0x7f) return false;
    }
    return true;
}

function isUtf8(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let i = 0;
    while (i < bytes.length) {
        const b0 = bytes[i++];
        let need;
        let min;
        let cp;
        if (b0 < 0x80) { continue; }
        else if ((b0 & 0xe0) === 0xc0) { need = 1; cp = b0 & 0x1f; min = 0x80; }
        else if ((b0 & 0xf0) === 0xe0) { need = 2; cp = b0 & 0x0f; min = 0x800; }
        else if ((b0 & 0xf8) === 0xf0) { need = 3; cp = b0 & 0x07; min = 0x10000; }
        else { return false; }
        for (let k = 0; k < need; k++) {
            if (i >= bytes.length || (bytes[i] & 0xc0) !== 0x80) return false;
            cp = (cp << 6) | (bytes[i++] & 0x3f);
        }
        if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    }
    return true;
}

module.exports = {
    Buffer,
    Blob,
    File,
    constants,
    kMaxLength,
    poolSize,
    transcode,
    isAscii,
    isUtf8,
};
