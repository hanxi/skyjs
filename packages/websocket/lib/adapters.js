"use strict";

// Adapters that expose the small "buffered reader" surface the RFC 6455 state
// machine needs, built strictly on the public net/stream facades.

const net = require("net");
const stream = require("stream");

const SOCKET_ERROR = Object.create(null);

class BufferedReader {
    constructor(fd) {
        this.fd = fd;
        this.chunks = [];
        this.total = 0;
        this.pending = null;
        this.closed = false;
        this.errorMsg = null;
        this._socket = fd;
    }

    onData(data) {
        if (data.byteLength === 0) return;
        this.chunks.push(data);
        this.total += data.byteLength;
        this.tryResolve();
    }

    onClose() {
        this.closed = true;
        if (this.pending) {
            const pending = this.pending;
            this.pending = null;
            pending.reject(SOCKET_ERROR);
        }
    }

    onError(msg) {
        this.errorMsg = msg;
        this.closed = true;
        if (this.pending) {
            const pending = this.pending;
            this.pending = null;
            pending.reject(SOCKET_ERROR);
        }
    }

    read(n) {
        if (this.pending) throw new Error("websocket: concurrent read not allowed");
        if (n <= 0) return Promise.resolve(new ArrayBuffer(0));
        if (this.total >= n) return Promise.resolve(this._consume(n));
        if (this.closed) return Promise.reject(SOCKET_ERROR);
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, needed: n, isLine: false };
        });
    }

    readline() {
        if (this.pending) throw new Error("websocket: concurrent read not allowed");
        const pos = this.scanCrlf();
        if (pos >= 0) {
            const lineBuf = this._consume(pos + 2);
            return Promise.resolve(new TextDecoder().decode(new Uint8Array(lineBuf, 0, pos)));
        }
        if (this.closed) return Promise.reject(SOCKET_ERROR);
        return new Promise((resolve, reject) => {
            this.pending = { resolve, reject, needed: 0, isLine: true };
        });
    }

    write(data) {
        if (typeof data === "string") {
            this._socket.write(data);
        } else {
            this._socket.write(Buffer.from(data));
        }
    }

    tryResolve() {
        if (!this.pending) return;
        if (this.pending.isLine) {
            const pos = this.scanCrlf();
            if (pos >= 0) {
                const pending = this.pending;
                this.pending = null;
                const lineBuf = this._consume(pos + 2);
                pending.resolve(new TextDecoder().decode(new Uint8Array(lineBuf, 0, pos)));
            }
        } else if (this.total >= this.pending.needed) {
            const pending = this.pending;
            this.pending = null;
            pending.resolve(this._consume(pending.needed));
        }
    }

    scanCrlf() {
        let offset = 0;
        let prevByte = -1;
        for (const chunk of this.chunks) {
            const view = new Uint8Array(chunk);
            for (let j = 0; j < view.length; j++) {
                if (prevByte === 0x0D && view[j] === 0x0A) return offset + j - 1;
                prevByte = view[j];
            }
            offset += view.length;
        }
        return -1;
    }

    _consume(n) {
        if (n === 0) return new ArrayBuffer(0);
        if (this.chunks.length > 0 && this.chunks[0].byteLength === n) {
            const buf = this.chunks.shift();
            this.total -= n;
            return buf;
        }
        const out = new Uint8Array(n);
        let remaining = n;
        let off = 0;
        while (remaining > 0) {
            const chunk = this.chunks[0];
            const avail = chunk.byteLength;
            if (avail <= remaining) {
                out.set(new Uint8Array(chunk), off);
                off += avail;
                remaining -= avail;
                this.chunks.shift();
            } else {
                out.set(new Uint8Array(chunk, 0, remaining), off);
                this.chunks[0] = chunk.slice(remaining);
                remaining = 0;
            }
        }
        this.total -= n;
        return out.buffer;
    }
}

/** Promise<fd> connect over the public net facade. */
function netConnect(host, port, timeout) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const socket = net.connect(port, host, () => {
            if (settled) return;
            settled = true;
            resolve(socket);
        });
        socket.on("error", (err) => {
            if (settled) return;
            settled = true;
            reject(err || SOCKET_ERROR);
        });
        socket.on("close", () => {
            if (settled) return;
            settled = true;
            reject(SOCKET_ERROR);
        });
        if (timeout !== undefined && timeout > 0) {
            socket.setTimeout(timeout * 10, () => {
                if (settled) return;
                settled = true;
                socket.destroy();
                reject(SOCKET_ERROR);
            });
        }
    });
}

/** Wrap an established net.Socket in a BufferedReader. */
function makeReader(socket) {
    const reader = new BufferedReader(socket);
    socket.on("data", (chunk) => {
        const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        reader.onData(ab);
    });
    socket.on("close", () => reader.onClose());
    socket.on("error", (msg) => reader.onError(msg));
    return reader;
}

// ---- minimal HTTP handshake helpers (server-side parse, client-side write) ---

function recvHeader(reader) {
    const lines = [];
    return (async () => {
        for (;;) {
            const line = await reader.readline();
            if (line === "") break;
            lines.push(line);
        }
        return { lines, ok: true };
    })();
}

function parseHeader(lines, from, header) {
    const out = header || {};
    for (let i = from; i < lines.length; i++) {
        const colon = lines[i].indexOf(":");
        if (colon < 0) continue;
        const name = lines[i].slice(0, colon).trim().toLowerCase();
        const value = lines[i].slice(colon + 1).trim();
        if (out[name] === undefined) out[name] = value;
        else if (Array.isArray(out[name])) out[name].push(value);
        else out[name] = [out[name], value];
    }
    return out;
}

function writeResponse(writeFn, code, reason) {
    writeFn("HTTP/1.1 " + code + " " + (reason || "") + "\r\n\r\n");
}

/**
 * Upgrade an established net.Socket to TLS. Server side wraps with the given
 * cert/key; client side verifies against `ca`. Returns a BufferedReader over
 * the (now encrypted) socket.
 */
async function tlsUpgrade(socket, host, isServer, certfile, keyfile, caFile) {
    // Only the public tls facade is used here (node-compatibility §16.4.1).
    const tls = require("tls");
    const session = await tls.upgrade(socket, {
        host,
        isServer: !!isServer,
        cert: certfile,
        key: keyfile,
        ca: caFile,
    });
    socket._tlsSession = session.session;
    socket._tlsCtx = session.ctx;

    const reader = makeReader(socket);
    const origOnData = reader.onData.bind(reader);
    const origWrite = reader.write.bind(reader);

    // Plaintext out -> encrypt -> raw socket; encrypted in -> decrypt -> reader.
    reader.write = function (data) {
        const buffer = typeof data === "string"
            ? new TextEncoder().encode(data).buffer
            : (data instanceof ArrayBuffer ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        session.write(buffer);
    };

    if (!session.finished()) {
        await new Promise((resolve, reject) => {
            reader.onData = function (encrypted) {
                try {
                    session.handshake(encrypted);
                    if (session.finished()) {
                        reader.onData = function (encData) {
                            const plaintext = session.read(encData);
                            if (plaintext && plaintext.byteLength > 0) origOnData(plaintext);
                        };
                        const leftover = session.read();
                        if (leftover && leftover.byteLength > 0) origOnData(leftover);
                        resolve();
                    }
                } catch (err) {
                    reject(err);
                }
            };
        });
    } else {
        reader.onData = function (encData) {
            const plaintext = session.read(encData);
            if (plaintext && plaintext.byteLength > 0) origOnData(plaintext);
        };
    }
    return reader;
}

module.exports = {
    SOCKET_ERROR,
    BufferedReader,
    netConnect,
    makeReader,
    recvHeader,
    parseHeader,
    writeResponse,
    tlsUpgrade,
};
