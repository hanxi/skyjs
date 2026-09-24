"use strict";

// WHATWG-compatible TextEncoder/TextDecoder subset. The full descriptor
// variants (stream, ignoreBOM, fatal) remain for the NC1 text-codec batch.

function encodeUtf8(input) {
    const text = input === undefined ? "" : String(input);
    const out = [];
    for (let i = 0; i < text.length; i++) {
        let cp = text.charCodeAt(i);
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
            const lo = text.charCodeAt(i + 1);
            if (lo >= 0xdc00 && lo <= 0xdfff) {
                cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                i++;
            }
        }
        if (cp < 0x80) {
            out.push(cp);
        } else if (cp < 0x800) {
            out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
            out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f),
                0x80 | (cp & 0x3f));
        } else {
            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        }
    }
    return new Uint8Array(out);
}

function decodeUtf8(input) {
    if (input === undefined) return "";
    let bytes;
    if (input instanceof Uint8Array) {
        bytes = input;
    } else if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
    } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
        throw new TypeError("TextDecoder.decode: expected BufferSource");
    }
    let out = "";
    let i = 0;
    while (i < bytes.length) {
        const b0 = bytes[i++];
        let cp;
        if (b0 < 0x80) {
            cp = b0;
        } else if ((b0 & 0xe0) === 0xc0) {
            if (i < bytes.length && (bytes[i] & 0xc0) === 0x80) {
                cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
            } else {
                cp = 0xfffd;
            }
        } else if ((b0 & 0xf0) === 0xe0) {
            if (i + 1 < bytes.length && (bytes[i] & 0xc0) === 0x80 &&
                (bytes[i + 1] & 0xc0) === 0x80) {
                cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) |
                    (bytes[i++] & 0x3f);
            } else {
                cp = 0xfffd;
            }
        } else if ((b0 & 0xf8) === 0xf0) {
            if (i + 2 < bytes.length && (bytes[i] & 0xc0) === 0x80 &&
                (bytes[i + 1] & 0xc0) === 0x80 &&
                (bytes[i + 2] & 0xc0) === 0x80) {
                cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                    ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
            } else {
                cp = 0xfffd;
            }
        } else {
            cp = 0xfffd;
        }
        if (cp > 0xffff) {
            cp -= 0x10000;
            out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
            out += String.fromCharCode(cp);
        }
    }
    return out;
}

class Utf8TextEncoder {
    constructor() {
        this.encoding = "utf-8";
    }

    encode(input) {
        return encodeUtf8(input);
    }

    encodeInto(input, destination) {
        const bytes = encodeUtf8(input);
        const view = destination instanceof Uint8Array ?
            destination : new Uint8Array(destination.buffer,
                destination.byteOffset, destination.byteLength);
        const written = Math.min(view.length, bytes.length);
        view.set(bytes.subarray(0, written));
        return { read: String(input).length, written };
    }
}

class Utf8TextDecoder {
    constructor(label) {
        const encoding = (label === undefined ? "utf-8" : String(label)).toLowerCase();
        if (encoding !== "utf-8" && encoding !== "utf8") {
            throw new RangeError("Unsupported encoding: " + label);
        }
        this.encoding = "utf-8";
    }

    decode(input) {
        return decodeUtf8(input);
    }
}

module.exports = {
    TextEncoder: Utf8TextEncoder,
    TextDecoder: Utf8TextDecoder,
};
