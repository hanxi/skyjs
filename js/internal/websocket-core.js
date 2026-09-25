// skyjs WebSocket server + client (Task 7, RFC 6455).
// Shared core behind the legacy global and the future require('websocket')
// facade. Reuses internal/http-core.js for the HTTP upgrade handshake.
//
// Ported from 3rd/skynet/lualib/http/websocket.lua. Reuses
// http_internal.recv_header / parse_header for the HTTP upgrade handshake.
// Frame masking uses crypt.xor_str (C-layer, hot path).
//
// Two usage modes:
//   Handler mode (server): websocket.accept(fd, handler, "ws", addr)
//   Manual mode  (client): websocket.connect("ws://...") → id
(function () {
    "use strict";

    const GLOBAL_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const MAX_FRAME_SIZE = 256 * 1024;   // 256 KB

    const textCodec = require("./text-codec.js");
    const crypt = require("./crypt-core.js");
    const netCore = require("./net-core.js");
    const netHelper = require("./net-core.js");
    const httpCore = require("./http-core.js");
    const textEncoder = new textCodec.TextEncoder();
    const textDecoder = new textCodec.TextDecoder("utf-8");

    // ---- opcode tables (name↔value) ----

    const opCode = {
        "frame":  0x00,
        "text":   0x01,
        "binary": 0x02,
        "close":  0x08,
        "ping":   0x09,
        "pong":   0x0A,
    };
    const opName = {};
    opName[0x00] = "frame";
    opName[0x01] = "text";
    opName[0x02] = "binary";
    opName[0x08] = "close";
    opName[0x09] = "ping";
    opName[0x0A] = "pong";

    // ---- helpers ----

    function toAb(data) {
        if (data instanceof ArrayBuffer) return data;
        if (typeof data === "string") return textEncoder.encode(data).buffer;
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(
                data.byteOffset, data.byteOffset + data.byteLength
            );
        }
        return new ArrayBuffer(0);
    }

    function abToStr(buf) {
        return textDecoder.decode(new Uint8Array(buf));
    }

    function concatAb(chunks, total) {
        const out = new Uint8Array(total);
        let off = 0;
        for (let i = 0; i < chunks.length; i++) {
            const src = new Uint8Array(chunks[i]);
            out.set(src, off);
            off += src.byteLength;
        }
        return out.buffer;
    }

    // ---- per-connection pool ----

    const wsPool = new Map();   // id → ws object

    function closeWebsocket(ws) {
        wsPool.delete(ws.id);
        if (!ws.closed) {
            ws.closed = true;
            try { netCore.close(ws.fd); } catch (_) { /* ignore */ }
        }
    }

    function isWsClosed(id) {
        return !wsPool.has(id);
    }

    // ---- frame codec (RFC 6455 §5) ----

    /**
     * Write a single WebSocket frame.
     *   write_fn(data): write closure (string or ArrayBuffer)
     *   opcode: "text" | "binary" | "close" | "ping" | "pong"
     *   payload: ArrayBuffer | string | null
     *   masking_key: 4-byte ArrayBuffer (client→server) or null (server→client)
     */
    function writeFrame(writeFn, opcode, payload, maskingKey) {
        payload = payload ? toAb(payload) : new ArrayBuffer(0);
        const payloadLen = payload.byteLength;
        const opV = opCode[opcode];
        if (opV === undefined) {
            throw new Error("websocket: unknown opcode " + opcode);
        }
        const v1 = 0x80 | opV;   // FIN = 1, no fragmented sends
        const maskBit = maskingKey ? 0x80 : 0x00;

        // calculate header layout
        let lenExtra = 0;
        if (payloadLen >= 126 && payloadLen <= 0xFFFF) {
            lenExtra = 2;
        } else if (payloadLen > 0xFFFF) {
            lenExtra = 8;
        }
        const maskExtra = maskingKey ? 4 : 0;
        const hdrSize = 2 + lenExtra + maskExtra;

        const hdr = new Uint8Array(hdrSize);
        const dv = new DataView(hdr.buffer);
        hdr[0] = v1;

        let off = 2;
        if (payloadLen < 126) {
            hdr[1] = maskBit | payloadLen;
        } else if (payloadLen <= 0xFFFF) {
            hdr[1] = maskBit | 126;
            dv.setUint16(2, payloadLen, false);   // big-endian
            off = 4;
        } else {
            hdr[1] = maskBit | 127;
            dv.setUint32(2,
                Math.floor(payloadLen / 0x100000000), false);
            dv.setUint32(6, payloadLen >>> 0, false);
            off = 10;
        }

        if (maskingKey) {
            const mk = new Uint8Array(toAb(maskingKey));
            hdr[off]     = mk[0];
            hdr[off + 1] = mk[1];
            hdr[off + 2] = mk[2];
            hdr[off + 3] = mk[3];
            // XOR payload with mask key (C-layer xor_str for performance)
            payload = crypt.xorStr(payload, maskingKey);
        }

        writeFn(hdr.buffer);
        if (payloadLen > 0) {
            writeFn(payload);
        }
    }

    /**
     * Read one WebSocket frame from `reader`.
     * Returns Promise<{ fin, opcode, payload: ArrayBuffer }>.
     */
    async function readFrame(reader, mode) {
        const s = await reader.read(2);
        const v = new Uint8Array(s);
        const fin  = (v[0] & 0x80) !== 0;
        const op   = v[0] & 0x0F;
        const mask = (v[1] & 0x80) !== 0;
        let payloadLen = v[1] & 0x7F;

        if (payloadLen === 126) {
            const ext = await reader.read(2);
            payloadLen = new DataView(ext).getUint16(0, false);
        } else if (payloadLen === 127) {
            const ext = await reader.read(8);
            const edv = new DataView(ext);
            payloadLen = edv.getUint32(0, false) * 0x100000000 +
                          edv.getUint32(4, false);
        }

        if (mode === "server" && payloadLen > MAX_FRAME_SIZE) {
            throw new Error("websocket: payload_len is too large");
        }

        const maskingKey = mask ? await reader.read(4) : null;
        let payload = payloadLen > 0
            ? await reader.read(payloadLen)
            : new ArrayBuffer(0);

        if (maskingKey) {
            payload = crypt.xorStr(payload, maskingKey);
        }

        const name = opName[op];
        if (!name) {
            throw new Error(
                "websocket: unknown opcode 0x" + op.toString(16)
            );
        }
        return { fin, opcode: name, payload };
    }

    /** Parse a close frame payload → { code, reason }. */
    function readClose(payload) {
        const len = payload.byteLength;
        if (len >= 2) {
            const dv = new DataView(payload);
            const code = dv.getUint16(0, false);
            const reason = len > 2 ? abToStr(payload.slice(2)) : "";
            return { code, reason };
        }
        return { code: undefined, reason: "" };
    }

    // ---- handler dispatch helper ----

    function tryHandle(ws, method, a1, a2) {
        const handle = ws.handle;
        if (!handle) return;
        const f = handle[method];
        if (!f) return;
        try {
            if (a2 !== undefined) f(ws.id, a1, a2);
            else if (a1 !== undefined) f(ws.id, a1);
            else f(ws.id);
        } catch (e) {
            if (e === netHelper.socketError) throw e;
            skynetcore.runtime.error("websocket handler." + method + " error: " + (e && e.stack || e));
        }
    }

    // ---- server handshake (read_handshake) ----

    async function readHandshake(ws, upgradeOps) {
        let header, url;

        if (upgradeOps) {
            header = upgradeOps.header;
            url = upgradeOps.url;
        } else {
            const hdr = await httpCore.httpInternal.recvHeader(ws.reader);
            if (!hdr.ok) return { code: 413 };
            if (hdr.lines.length === 0) return { code: 400 };

            const requestLine = hdr.lines[0];
            const m = requestLine.match(
                /^([A-Za-z]+)\s+(.*?)\s+HTTP\/(\d+\.\d+)$/
            );
            if (!m) return { code: 400, reason: "Bad Request" };

            const method = m[1];
            url = m[2];
            const httpver = parseFloat(m[3]);

            if (method !== "GET") {
                return { code: 400, reason: "need GET method" };
            }
            if (httpver < 1.1) {
                return { code: 505 };
            }

            header = httpCore.httpInternal.parseHeader(hdr.lines, 1, {});
        }

        if (!header) return { code: 400 };

        // Validate required WebSocket headers (RFC 6455 §4.2.1)
        const upgrade = header["upgrade"];
        if (!upgrade || upgrade.toLowerCase() !== "websocket") {
            return { code: 426, reason: "Upgrade Required" };
        }

        if (!header["host"]) {
            return { code: 400, reason: "host Required" };
        }

        const connection = header["connection"];
        if (!connection ||
            connection.toLowerCase().indexOf("upgrade") < 0) {
            return { code: 400, reason: "Connection must Upgrade" };
        }

        const swKey = header["sec-websocket-key"];
        if (!swKey) {
            return { code: 400, reason: "Sec-WebSocket-Key Required" };
        }
        const rawKey = crypt.base64Decode(swKey);
        if (rawKey.byteLength !== 16) {
            return { code: 400, reason: "Sec-WebSocket-Key invalid" };
        }

        const swVer = header["sec-websocket-version"];
        if (!swVer || swVer !== "13") {
            return { code: 400, reason: "Sec-WebSocket-Version must 13" };
        }

        // sub-protocol negotiation (mirror original Lua behavior)
        let subPro = "";
        const swProtocol = header["sec-websocket-protocol"];
        if (swProtocol) {
            const protocols = swProtocol.split(/[\s,]+/);
            if (protocols.indexOf("chat") >= 0) {
                subPro = "Sec-WebSocket-Protocol: chat\r\n";
            }
        }

        // x-real-ip from reverse proxy (nginx)
        ws.realIp = header["x-real-ip"] || null;

        // generate Sec-WebSocket-Accept and send 101
        const accept = crypt.base64Encode(
            crypt.sha1(swKey + GLOBAL_GUID)
        );
        const resp = "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " + accept + "\r\n" +
            subPro +
            "\r\n";
        ws.reader.write(resp);

        return { code: null, header, url };
    }

    // ---- client handshake (write_handshake) ----

    async function writeHandshake(ws, host, url, header) {
        // 16-byte random key: two 8-byte crypt.randomkey() concatenated
        const rk1 = crypt.randomkey();
        const rk2 = crypt.randomkey();
        const keyBuf = new Uint8Array(16);
        keyBuf.set(new Uint8Array(rk1), 0);
        keyBuf.set(new Uint8Array(rk2), 8);
        const key = crypt.base64Encode(keyBuf.buffer);

        const reqHdr = {
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": key,
        };
        if (header) {
            const keys = Object.keys(header);
            for (let i = 0; i < keys.length; i++) {
                reqHdr[keys[i]] = header[keys[i]];
            }
        }

        // build HTTP GET request
        let req = "GET " + url + " HTTP/1.1\r\n";
        req += "Host: " + host + "\r\n";
        const hkeys = Object.keys(reqHdr);
        for (let i = 0; i < hkeys.length; i++) {
            req += hkeys[i] + ": " + reqHdr[hkeys[i]] + "\r\n";
        }
        req += "\r\n";
        ws.reader.write(req);

        // read 101 response
        const hdr = await httpCore.httpInternal.recvHeader(ws.reader);
        if (!hdr.ok || hdr.lines.length === 0) {
            throw new Error("websocket handshake: recv header failed");
        }

        const sm = hdr.lines[0].match(/HTTP\/[\d.]+\s+(\d+)\s*(.*)/);
        if (!sm) {
            throw new Error("websocket handshake: invalid status line");
        }
        const code = parseInt(sm[1], 10);
        if (code !== 101) {
            throw new Error(
                "websocket handshake error: code[" + code +
                "] info:" + sm[2]
            );
        }

        const recvHdr = httpCore.httpInternal.parseHeader(hdr.lines, 1, {});
        if (!recvHdr) {
            throw new Error(
                "websocket handshake: invalid response header"
            );
        }

        if (!recvHdr["upgrade"] ||
            recvHdr["upgrade"].toLowerCase() !== "websocket") {
            throw new Error(
                "websocket handshake: upgrade must websocket"
            );
        }

        if (!recvHdr["connection"] ||
            recvHdr["connection"].toLowerCase() !== "upgrade") {
            throw new Error(
                "websocket handshake: connection must upgrade"
            );
        }

        const swAccept = recvHdr["sec-websocket-accept"];
        if (!swAccept) {
            throw new Error(
                "websocket handshake: need Sec-WebSocket-Accept"
            );
        }

        const expected = crypt.base64Encode(
            crypt.sha1(key + GLOBAL_GUID)
        );
        if (swAccept !== expected) {
            throw new Error(
                "websocket handshake: invalid Sec-WebSocket-Accept"
            );
        }
    }

    // ---- server accept message loop ----

    async function resolveAccept(ws, options) {
        tryHandle(ws, "connect");

        const hs = await readHandshake(
            ws, options && options.upgrade
        );
        if (hs.code !== null) {
            // handshake failed: send HTTP error response
            const wf = function (d) { ws.reader.write(d); };
            httpCore.httpd.writeResponse(wf, hs.code, hs.reason || "");
            tryHandle(ws, "close");
            return;
        }

        tryHandle(ws, "handshake", hs.header, hs.url);

        // fragment reassembly state
        const recvBuf = [];
        let recvCount = 0;
        let firstOp = null;

        while (true) {
            if (isWsClosed(ws.id)) {
                tryHandle(ws, "close");
                return;
            }

            const frame = await readFrame(ws.reader, ws.mode);

            if (frame.opcode === "close") {
                const ci = readClose(frame.payload);
                // echo close frame back
                writeFrame(
                    function (d) { ws.reader.write(d); }, "close"
                );
                tryHandle(ws, "close", ci.code, ci.reason);
                return;
            }

            if (frame.opcode === "ping") {
                writeFrame(
                    function (d) { ws.reader.write(d); },
                    "pong", frame.payload
                );
                tryHandle(ws, "ping");
                continue;
            }

            if (frame.opcode === "pong") {
                tryHandle(ws, "pong");
                continue;
            }

            // data frame (text / binary / continuation)
            if (frame.fin && recvBuf.length === 0) {
                // single-frame message
                tryHandle(ws, "message", frame.payload, frame.opcode);
            } else {
                // fragmented message: accumulate
                recvBuf.push(frame.payload);
                recvCount += frame.payload.byteLength;
                if (recvCount > MAX_FRAME_SIZE) {
                    throw new Error(
                        "websocket: payload_len is too large"
                    );
                }
                if (!firstOp) firstOp = frame.opcode;
                if (frame.fin) {
                    const full = concatAb(recvBuf, recvCount);
                    tryHandle(ws, "message", full, firstOp);
                    recvBuf.length = 0;
                    recvCount = 0;
                    firstOp = null;
                }
            }
        }
    }

    // ---- URL parsing ----

    function parseWsUrl(url) {
        const m = url.match(/^(wss?):\/\/([^/]+)(.*)?$/);
        if (!m) throw new Error("websocket: invalid URL " + url);
        const protocol = m[1];
        const host = m[2];
        let uri = m[3] || "/";
        if (uri === "") uri = "/";

        const hm = host.match(/^([^:]+):?(\d*)$/);
        if (!hm) throw new Error("websocket: invalid host " + host);
        const hostAddr = hm[1];
        let hostPort = hm[2] ? parseInt(hm[2], 10) : 0;
        if (!hostPort) {
            hostPort = protocol === "ws" ? 80 : 443;
        }

        // hostname for TLS SNI (only if not a bare IP address)
        let hostname = null;
        if (!/\d+$/.test(hostAddr)) {
            hostname = hostAddr;
        }

        return {
            protocol, host, hostAddr, hostPort, hostname, uri,
        };
    }

    // ========================================== public API

    const wsApi = {};

    /**
     * Server entry: accept a WebSocket connection on `fd`.
     *   handler: { connect?, handshake?, message, ping?, pong?,
     *              close?, error?, warning? }
     *   protocol: "ws" (default) | "wss"
     *   options.upgrade: { header, method, url } to skip HTTP parsing
     *   options.reader: existing BufferedReader to reuse
     * Returns Promise<boolean>.
     */
    wsApi.accept = async function (fd, handler, protocol, addr,
        options) {
        protocol = protocol || "ws";

        // reuse caller's reader if provided (e.g. HTTP server upgrade),
        // otherwise create a fresh one
        let reader;
        if (options && options.reader) {
            reader = options.reader;
        } else {
            reader = netHelper.reader(fd);
        }

        if (protocol === "wss") {
            if (!skynetcore.tls) {
                netCore.close(fd);
                throw new Error(
                    "WSS requires OpenSSL build (make TLS=openssl)"
                );
            }
            const tlsOpts = (options && options.tls) || {};
            if (!tlsOpts.certfile || !tlsOpts.keyfile) {
                netCore.close(fd);
                throw new Error(
                    "WSS server requires options.tls.certfile and options.tls.keyfile"
                );
            }
            await netHelper.tlsUpgrade(
                reader, null, true, tlsOpts.certfile, tlsOpts.keyfile
            );
        }

        const ws = {
            id: fd, fd: fd, reader: reader,
            mode: "server", handle: handler,
            addr: addr || "", realIp: null, closed: false,
        };
        wsPool.set(fd, ws);

        try {
            await resolveAccept(ws, options);
        } catch (e) {
            const closed = isWsClosed(fd);
            if (!closed) {
                closeWebsocket(ws);
            }
            if (e === netHelper.socketError) {
                if (closed) {
                    tryHandle(ws, "close");
                } else {
                    tryHandle(ws, "error", e);
                }
            } else {
                return false;
            }
            return true;
        }

        if (!isWsClosed(fd)) {
            closeWebsocket(ws);
        }
        return true;
    };

    /**
     * Client entry: connect to a WebSocket server.
     *   url: "ws://host:port/path" or "wss://..."
     *   header: extra headers object (optional)
     *   timeout: connect timeout in centiseconds (optional)
     * Returns Promise<id> (the fd).
     */
    wsApi.connect = async function (url, header, timeout, options) {
        const parsed = parseWsUrl(url);

        const fd = await netHelper.connectAsync(
            parsed.hostAddr, parsed.hostPort, timeout
        );
        const reader = netHelper.reader(fd);

        if (parsed.protocol === "wss") {
            if (!skynetcore.tls) {
                netCore.close(fd);
                throw new Error(
                    "WSS requires OpenSSL build (make TLS=openssl)"
                );
            }
            const ca = (options && options.caFile) || undefined;
            await netHelper.tlsUpgrade(
                reader, parsed.hostname, false, null, null, ca
            );
        }

        const ws = {
            id: fd, fd: fd, reader: reader,
            mode: "client", handle: null,
            addr: parsed.host, realIp: null, closed: false,
        };
        wsPool.set(fd, ws);

        try {
            await writeHandshake(
                ws, parsed.host, parsed.uri, header
            );
        } catch (e) {
            closeWebsocket(ws);
            throw e;
        }

        return fd;
    };

    /**
     * Manual read: read one complete message (auto ping/pong,
     * fragment reassembly).
     * Returns { data: ArrayBuffer, type: "text"|"binary", close: false }
     *      or { data: null, close: true, code, reason }.
     */
    wsApi.read = async function (id) {
        const ws = wsPool.get(id);
        if (!ws) throw new Error("websocket: invalid id " + id);

        const recvBuf = [];
        let recvCount = 0;
        let firstOp = null;

        while (true) {
            const frame = await readFrame(ws.reader, ws.mode);

            if (frame.opcode === "close") {
                closeWebsocket(ws);
                const ci = readClose(frame.payload);
                return {
                    data: null, close: true,
                    code: ci.code, reason: ci.reason,
                };
            }

            if (frame.opcode === "ping") {
                // auto-respond with pong (masking for client only)
                const mk = ws.mode === "client"
                    ? crypt.randomBytes(4) : null;
                writeFrame(
                    function (d) { ws.reader.write(d); },
                    "pong", frame.payload, mk
                );
                continue;
            }

            if (frame.opcode === "pong") {
                continue;   // ignore, read next frame
            }

            // data frame (text / binary / continuation)
            if (frame.fin && recvBuf.length === 0) {
                return {
                    data: frame.payload, type: frame.opcode,
                    close: false,
                };
            }

            recvBuf.push(frame.payload);
            recvCount += frame.payload.byteLength;
            if (recvCount > MAX_FRAME_SIZE) {
                throw new Error("websocket: payload_len is too large");
            }
            if (!firstOp) firstOp = frame.opcode;
            if (frame.fin) {
                const full = concatAb(recvBuf, recvCount);
                return {
                    data: full, type: firstOp, close: false,
                };
            }
        }
    };

    /**
     * Send a WebSocket frame.
     *   fmt: "text" (default) | "binary"
     *   data: string | ArrayBuffer
     * Client frames are automatically masked (RFC 6455 §5.3).
     */
    wsApi.write = function (id, data, fmt) {
        const ws = wsPool.get(id);
        if (!ws) throw new Error("websocket: invalid id " + id);
        fmt = fmt || "text";
        if (fmt !== "text" && fmt !== "binary") {
            throw new Error(
                "websocket: fmt must be 'text' or 'binary'"
            );
        }
        const payload = toAb(data);
        const mk = ws.mode === "client"
            ? crypt.randomBytes(4) : null;
        writeFrame(
            function (d) { ws.reader.write(d); }, fmt, payload, mk
        );
    };

    /** Send a ping frame. */
    wsApi.ping = function (id) {
        const ws = wsPool.get(id);
        if (!ws) throw new Error("websocket: invalid id " + id);
        const mk = ws.mode === "client"
            ? crypt.randomBytes(4) : null;
        writeFrame(
            function (d) { ws.reader.write(d); }, "ping", null, mk
        );
    };

    /** Send a close frame and close the connection. */
    wsApi.close = function (id, code, reason) {
        const ws = wsPool.get(id);
        if (!ws) return;
        try {
            reason = reason || "";
            let payload = null;
            if (code !== undefined && code !== null) {
                const reasonBytes = textEncoder.encode(reason);
                const buf = new ArrayBuffer(
                    2 + reasonBytes.byteLength
                );
                new DataView(buf).setUint16(0, code, false);
                new Uint8Array(buf).set(reasonBytes, 2);
                payload = buf;
            }
            const mk = ws.mode === "client"
                ? crypt.randomBytes(4) : null;
            writeFrame(
                function (d) { ws.reader.write(d); },
                "close", payload, mk
            );
        } catch (_) {
            // ignore write errors during close
        }
        closeWebsocket(ws);
    };

    /** Return connection address info. */
    wsApi.addrinfo = function (id) {
        const ws = wsPool.get(id);
        return ws ? ws.addr : "";
    };

    /** Return x-real-ip header value (from reverse proxy). */
    wsApi.realIp = function (id) {
        const ws = wsPool.get(id);
        return ws ? (ws.realIp || "") : "";
    };

    /** Check if connection is closed. */
    wsApi.isClose = function (id) {
        return isWsClosed(id);
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = wsApi;
    }
})();
