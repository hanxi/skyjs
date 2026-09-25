// skyjs socket core (Task 4).
// Wraps the skynet socket API (event-driven, one C socket thread) with
// per-connection callbacks. Socket DATA crosses the C boundary as an
// ArrayBuffer (binary-safe); by default on_data receives a decoded UTF-8
// string, or the raw ArrayBuffer when a connection opts into binary mode.
(function () {
    "use strict";

    const hooks = require("./runtime-hooks.js");
    const skynetCore = require("./skynet-core.js");
    const DATA = 1, CONNECT = 2, CLOSE = 3, ACCEPT = 4, ERROR = 5;

    const handlers = new Map();

    function dispatchEvent(m) {
        const h = handlers.get(m.id);
        if (!h) return;
        switch (m.type) {
            case DATA:
                // C delivers DATA as an ArrayBuffer; decode to a string unless
                // this connection opted into per-connection binary mode
                if (h.onData) h.onData(h.binary ? m.data : skynetcore.seri.str(m.data), m.ud);
                break;
            case CONNECT:
                // resume_socket() re-reports OPEN with a status text; only a
                // real connection established (data = host) triggers on_connect
                if (m.data === "transfer" || m.data === "start" || m.data === "binding") return;
                if (h.onConnect) h.onConnect(m.id);
                break;
            case ACCEPT: {
                // m.ud is the new connection id owned by this service
                if (h.onAccept) h.onAccept(m.ud, m.data);
                break;
            }
            case CLOSE:
                handlers.delete(m.id);
                if (h.onClose) h.onClose(m.id);
                break;
            case ERROR:
                handlers.delete(m.id);
                if (h.onError) h.onError(m.id, m.data);
                break;
        }
    }

    hooks.setSocketHandler(dispatchEvent);

    const sock = skynetcore.net;

    const socketObject = {
        listen(host, port, onAccept, backlog) {
            const id = sock.listen(String(host), port | 0, backlog || 64);
            if (id >= 0) {
                handlers.set(id, { onAccept });
                // a freshly created listener is in PListen state; start it
                // (emits an OPEN/"start" event which dispatch_event filters out)
                sock.start(id | 0);
            }
            return id;
        },
        /**
         * Initiate a TCP connection.
         * NOTE: Only on_connect is registered at this stage. You MUST call
         * socket.start(id, on_data, on_close, on_error) after connect resolves
         * to receive error/close notifications. If the connection fails before
         * start() is called, the error is silently dropped.
         */
        connect(host, port, onConnect) {
            const id = sock.connect(String(host), port | 0);
            if (id >= 0) handlers.set(id, { onConnect });
            return id;
        },
        // register data callbacks only; does NOT resume the socket. opts.binary
        // delivers on_data payloads as raw ArrayBuffer (default: UTF-8 string).
        start(id, onData, onClose, onError, opts) {
            const h = handlers.get(id) || {};
            h.onData = onData;
            h.onClose = onClose;
            h.onError = onError;
            h.binary = !!(opts && opts.binary);
            handlers.set(id, h);
        },
        // required for accepted connections (PAccept -> Connected)
        resume(id) {
            sock.start(id | 0);
        },
        // data may be a string (UTF-8), an ArrayBuffer, or a typed-array view
        write(id, data) {
            if (data instanceof ArrayBuffer) return sock.send(id | 0, data);
            if (ArrayBuffer.isView(data)) {
                return sock.send(id | 0,
                    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            }
            return sock.send(id | 0, String(data));
        },
        close(id) {
            handlers.delete(id);
            sock.close(id | 0);
        },
        shutdown(id) {
            sock.shutdown(id | 0);
        },
    };


        const CR = 0x0D;
        const LF = 0x0A;

        // sentinel object: callers use === to distinguish socket-layer failures
        // from application-level errors (never instanceof, never string compare)
        const socketError = Object.create(null);

        // ---------------------------------------------------------------- helpers

        const textCodec = require("./text-codec.js");
        const textDecoder = new textCodec.TextDecoder("utf-8");

        /**
         * Concatenate an array of ArrayBuffers into one.
         */
        function concatBuffers(chunks, total) {
            const out = new Uint8Array(total);
            let off = 0;
            for (let i = 0; i < chunks.length; i++) {
                const src = new Uint8Array(chunks[i]);
                out.set(src, off);
                off += src.byteLength;
            }
            return out.buffer;
        }

        // --------------------------------------------------------- BufferedReader

        class BufferedReader {
            constructor(fd) {
                this.fd = fd;
                this.chunks = [];       // ArrayBuffer queue
                this.total = 0;         // total buffered bytes
                this.pending = null;    // { resolve, reject, needed, is_line }
                this.closed = false;
                this.errorMsg = null;
            }

            // -- callback methods (bound and passed to socket.start) -------------

            onData(data) {
                if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return;
                this.chunks.push(data);
                this.total += data.byteLength;
                this.tryResolve();
            }

            onClose() {
                this.closed = true;
                if (this.pending) {
                    const p = this.pending;
                    this.pending = null;
                    p.reject(socketError);
                }
            }

            onError(msg) {
                this.errorMsg = msg;
                this.closed = true;
                if (this.pending) {
                    const p = this.pending;
                    this.pending = null;
                    p.reject(socketError);
                }
            }

            // -- public read methods --------------------------------------------

            /**
             * Read exactly `n` bytes. Returns a Promise<ArrayBuffer>.
             */
            read(n) {
                if (this.pending) {
                    throw new Error("sockethelper: concurrent read not allowed");
                }
                if (n <= 0) {
                    return Promise.resolve(new ArrayBuffer(0));
                }
                // fast path: already have enough data
                if (this.total >= n) {
                    return Promise.resolve(this._consume(n));
                }
                if (this.closed) {
                    return Promise.reject(socketError);
                }
                return new Promise((resolve, reject) => {
                    this.pending = { resolve, reject, needed: n, isLine: false };
                });
            }

            /**
             * Read until CRLF (\r\n). Returns a Promise<string> WITHOUT the \r\n.
             */
            readline() {
                if (this.pending) {
                    throw new Error("sockethelper: concurrent read not allowed");
                }
                // scan existing buffer for CRLF
                const pos = this.scanCrlf();
                if (pos >= 0) {
                    // consume pos bytes (the line) + 2 bytes (CRLF)
                    const lineBuf = this._consume(pos + 2);
                    // return string without trailing CRLF
                    const view = new Uint8Array(lineBuf, 0, pos);
                    return Promise.resolve(textDecoder.decode(view));
                }
                if (this.closed) {
                    return Promise.reject(socketError);
                }
                return new Promise((resolve, reject) => {
                    this.pending = { resolve, reject, needed: 0, isLine: true };
                });
            }

            // -- write (replaceable by TLS upgrade) -----------------------------

            write(data) {
                socketObject.write(this.fd, data);
            }

            // -- internal methods -----------------------------------------------

            /**
             * Check if the pending promise can be resolved now.
             */
            tryResolve() {
                if (!this.pending) return;
                if (this.pending.isLine) {
                    const pos = this.scanCrlf();
                    if (pos >= 0) {
                        const p = this.pending;
                        this.pending = null;
                        const lineBuf = this._consume(pos + 2);
                        const view = new Uint8Array(lineBuf, 0, pos);
                        p.resolve(textDecoder.decode(view));
                    }
                } else {
                    if (this.total >= this.pending.needed) {
                        const p = this.pending;
                        this.pending = null;
                        p.resolve(this._consume(p.needed));
                    }
                }
            }

            /**
             * Consume exactly `n` bytes from the chunk queue. Returns ArrayBuffer.
             * Handles partial chunk consumption (keeps remainder).
             */
            _consume(n) {
                if (n === 0) return new ArrayBuffer(0);

                // optimisation: if the first chunk has exactly n bytes, return it
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
                        // consume entire chunk
                        out.set(new Uint8Array(chunk), off);
                        off += avail;
                        remaining -= avail;
                        this.chunks.shift();
                    } else {
                        // partial chunk: take what we need, keep remainder
                        out.set(new Uint8Array(chunk, 0, remaining), off);
                        this.chunks[0] = chunk.slice(remaining);
                        remaining = 0;
                    }
                }
                this.total -= n;
                return out.buffer;
            }

            /**
             * Scan buffered chunks for \r\n (CRLF). Returns the byte offset of
             * the start of the CRLF pair, or -1 if not found.
             */
            scanCrlf() {
                let offset = 0;
                let prevByte = -1;
                for (let i = 0; i < this.chunks.length; i++) {
                    const view = new Uint8Array(this.chunks[i]);
                    for (let j = 0; j < view.length; j++) {
                        if (prevByte === CR && view[j] === LF) {
                            // found CRLF: the CR is at (offset + j - 1) in global
                            // terms, but we track offset as the position of view[0]
                            // in the global stream
                            return offset + j - 1;
                        }
                        prevByte = view[j];
                    }
                    offset += view.length;
                }
                return -1;
            }
        }

        // -------------------------------------------------------- connect helper

        /**
         * Connect to host:port with optional timeout (centiseconds).
         * Returns Promise<fd>.
         */
        function helperConnect(host, port, timeout) {
            return new Promise((resolve, reject) => {
                let settled = false;
                let timerSession = 0;

                const fd = socketObject.connect(host, port, function onConnect(id) {
                    if (settled) return;
                    settled = true;
                    resolve(id);
                });

                if (fd < 0) {
                    settled = true;
                    reject(socketError);
                    return;
                }

                // register an error handler so early failures reject the promise
                socketObject.start(fd,
                    null,   // on_data: not needed yet
                    function onClose() {
                        if (settled) return;
                        settled = true;
                        reject(socketError);
                    },
                    function onError(_id, msg) {
                        if (settled) return;
                        settled = true;
                        reject(socketError);
                    }
                );

                if (timeout !== undefined && timeout > 0) {
                    timerSession = skynet.timeout(timeout, function () {
                        if (settled) return;
                        settled = true;
                        socketObject.close(fd);
                        reject(socketError);
                    });
                }
            });
        }

        // ------------------------------------------------------- writefunc helper

        /**
         * Returns a write closure that calls socket.write and throws socket_error
         * on failure.
         */
        function helperWritefunc(fd) {
            return function (data) {
                const r = socketObject.write(fd, data);
                if (r === undefined || r < 0) {
                    throw socketError;
                }
            };
        }

        // ------------------------------------------------------- public interface

        // --------------------------------------------------------- TLS upgrade

        /**
         * Upgrade a BufferedReader to TLS. Replaces the reader's _on_data
         * and write methods to transparently encrypt/decrypt. Drives the
         * TLS handshake to completion before returning.
         *
         * @param {BufferedReader} reader - reader to upgrade (in-place)
         * @param {string} [hostname] - SNI hostname (client mode)
         * @param {boolean} [is_server] - server mode if true
         * @param {string} [certfile] - PEM cert chain (server mode)
         * @param {string} [keyfile] - PEM private key (server mode)
         * @returns {Promise<void>}
         */
        async function tlsUpgrade(reader, hostname, isServer, certfile, keyfile, caFile) {
            const tls = skynetcore.tls;
            if (!tls) throw new Error("TLS requires OpenSSL build (make TLS=openssl)");

            tls.init();  // idempotent
            const ctx = tls.ctxNew(!!isServer);
            if (isServer && certfile && keyfile) {
                tls.ctxSetCert(ctx, certfile, keyfile);
            }
            if (!isServer) {
                tls.ctxSetVerify(ctx, caFile || undefined);
            }

            const method = isServer ? "server" : "client";
            const session = tls.newtls(method, ctx, hostname || undefined);

            // Save original pipeline methods
            const origonData = reader.onData.bind(reader);
            const origWrite = reader.write.bind(reader);

            // Replace write: plaintext → TLS encrypt → raw socket write
            reader.write = function (data) {
                if (typeof data === "string") {
                    const enc = new textCodec.TextEncoder();
                    data = enc.encode(data).buffer;
                } else if (!(data instanceof ArrayBuffer)) {
                    if (ArrayBuffer.isView(data)) {
                        data = data.buffer.slice(
                            data.byteOffset,
                            data.byteOffset + data.byteLength
                        );
                    }
                }
                const encrypted = tls.write(session, data);
                if (encrypted) origWrite(encrypted);
            };

            // Store session for reference
            reader.tlsSession = session;
            reader.tlsCtx = ctx;

            // Drive TLS handshake
            // Client sends first (ClientHello)
            const initial = tls.handshake(session);
            if (initial) origWrite(initial);

            // Handshake loop: wait for data, feed to handshake, send responses
            if (!tls.finished(session)) {
                await new Promise((resolve, reject) => {
                    // Temporarily intercept _on_data for the handshake phase
                    reader.onData = function (encrypted) {
                        try {
                            const out = tls.handshake(session, encrypted);
                            if (out) origWrite(out);
                            if (tls.finished(session)) {
                                // Handshake complete: install decrypt pipeline
                                reader.onData = function (encData) {
                                    const plaintext = tls.read(session, encData);
                                    if (plaintext && plaintext.byteLength > 0) {
                                        origonData(plaintext);
                                    }
                                };
                                // The peer may have coalesced application data
                                // (e.g. the WebSocket upgrade request) into the
                                // same TCP segment as its final handshake record.
                                // Such data is now buffered in the TLS input BIO
                                // but would never trigger another _on_data (the
                                // peer is waiting for our reply). Drain it now so
                                // the awaiting reader sees it, avoiding a deadlock.
                                const leftover = tls.read(session);
                                if (leftover && leftover.byteLength > 0) {
                                    origonData(leftover);
                                }
                                resolve();
                            }
                        } catch (e) {
                            reject(e);
                        }
                    };
                });
            } else {
                // Handshake already finished (unlikely but handle it)
                reader.onData = function (encData) {
                    const plaintext = tls.read(session, encData);
                    if (plaintext && plaintext.byteLength > 0) {
                        origonData(plaintext);
                    }
                };
            }
        }

        // ------------------------------------------------------- public interface

        const socketHelper = {
            socketError,
            BufferedReader,
            connect: helperConnect,
            writefunc: helperWritefunc,
            tlsUpgrade,

            /**
             * Convenience: create a BufferedReader for `fd`, register socket
             * callbacks with binary mode, and resume the socket.
             */
            reader(fd) {
                const r = new BufferedReader(fd);
                socketObject.start(fd,
                    (data) => r.onData(data),
                    () => r.onClose(),
                    (_id, msg) => r.onError(msg),
                    { binary: true }
                );
                socketObject.resume(fd);
                return r;
            },
        };
        module.exports = socketHelper;

    // NC4.1: socket lifecycle + buffered reader + TLS upgrade in one module.
    // `connect` stays the raw callback API; the promise helper is connectAsync.
    Object.assign(socketObject, {
        socketError,
        BufferedReader,
        connectAsync: socketHelper.connect,
        writefunc: socketHelper.writefunc,
        tlsUpgrade,
        reader: socketHelper.reader,
    });
    module.exports = socketObject;
})();
