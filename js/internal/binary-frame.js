"use strict";

// Cross-service binary envelope: a small JSON header + optional binary body.
// Wire layout (all lengths big-endian), so a reader can frame a partial stream
// without parsing the header first:
//   [magic:4][headerLength:4][bodyLength:4][header JSON][body]

const MAGIC = 0x534b594a; // "SKYJ"
const HEADER_OFFSET = 12;
const MAX_HEADER = 64 * 1024;

function frameEncode(header, body) {
    if (header === null || typeof header !== "object") {
        throw new TypeError("frameEncode(header, body): header must be an object");
    }
    const headerJson = JSON.stringify(header);
    const headerBytes = utf8Encode(headerJson);
    if (headerBytes.length > MAX_HEADER) {
        const err = new Error("frame header too large: " + headerBytes.length);
        err.code = "ERR_LIMIT_EXCEEDED";
        err.detail = { skyjsCode: "ERR_LIMIT_EXCEEDED", limit: MAX_HEADER };
        throw err;
    }
    const bodyBytes = body === undefined || body === null ? null : toBytes(body);
    const bodyLength = bodyBytes ? bodyBytes.length : 0;
    const total = HEADER_OFFSET + headerBytes.length + bodyLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, false);
    view.setUint32(4, headerBytes.length, false);
    view.setUint32(8, bodyLength, false);
    out.set(headerBytes, HEADER_OFFSET);
    if (bodyBytes) out.set(bodyBytes, HEADER_OFFSET + headerBytes.length);
    return out.buffer;
}

function frameDecode(buffer) {
    const bytes = toBytes(buffer);
    if (bytes.length < HEADER_OFFSET) {
        throw protocolError("frame too short: " + bytes.length);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) !== MAGIC) {
        throw protocolError("bad frame magic");
    }
    const headerLength = view.getUint32(4, false);
    const bodyLength = view.getUint32(8, false);
    if (headerLength > MAX_HEADER) {
        throw protocolError("frame header too large: " + headerLength);
    }
    if (HEADER_OFFSET + headerLength + bodyLength !== bytes.length) {
        throw protocolError("frame length mismatch");
    }
    const headerText = utf8Decode(
        bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLength));
    let header;
    try {
        header = JSON.parse(headerText);
    } catch (err) {
        throw protocolError("frame header is not valid JSON");
    }
    const bodyStart = HEADER_OFFSET + headerLength;
    const body = bodyLength > 0 ?
        bytes.buffer.slice(bytes.byteOffset + bodyStart,
            bytes.byteOffset + bodyStart + bodyLength) : null;
    return { header, body };
}

function protocolError(message) {
    const err = new Error(message);
    err.code = "ERR_PROTOCOL";
    err.detail = { skyjsCode: "ERR_PROTOCOL" };
    return err;
}

function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new TypeError("frame payload must be an ArrayBuffer or view");
}

function utf8Encode(text) {
    return new TextEncoder().encode(text);
}

function utf8Decode(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
}

// Streaming splitter for credit-based cross-service flows (stateful across
// partial reads); feed chunks, get complete frames back.
class FrameDecoder {
    constructor() {
        this.buffer = new Uint8Array(0);
    }

    push(chunk) {
        const incoming = toBytes(chunk);
        const merged = new Uint8Array(this.buffer.length + incoming.length);
        merged.set(this.buffer, 0);
        merged.set(incoming, this.buffer.length);
        this.buffer = merged;

        const frames = [];
        for (;;) {
            if (this.buffer.length < HEADER_OFFSET) break;
            const view = new DataView(this.buffer.buffer, this.buffer.byteOffset,
                this.buffer.length);
            if (view.getUint32(0, false) !== MAGIC) {
                throw protocolError("bad frame magic");
            }
            const headerLength = view.getUint32(4, false);
            const bodyLength = view.getUint32(8, false);
            if (headerLength > MAX_HEADER) {
                throw protocolError("frame header too large: " + headerLength);
            }
            const headerEnd = HEADER_OFFSET + headerLength;
            if (this.buffer.length < headerEnd) break;
            const total = headerEnd + bodyLength;
            if (this.buffer.length < total) break;
            frames.push(frameDecode(this.buffer.subarray(0, total)));
            this.buffer = this.buffer.subarray(total).slice();
        }
        return frames;
    }
}

module.exports = { MAGIC, frameEncode, frameDecode, FrameDecoder };
