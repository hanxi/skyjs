// skyjs HTTP server + client with Keep-Alive connection pool (Task 6).
// Shared by the legacy lazy globals and the require-based facades. Provides
// httpd (server), httpc (client), and the internal parsing functions reused
// by websocket.js.
//
// Ported from 3rd/skynet/lualib/http/{internal,httpd,httpc,url}.lua.
// Builds entirely on BufferedReader (internal/net-core.js): readline() for
// header lines, read(n) for exact-length body reads.
(function () {
    "use strict";

    const LIMIT = 8192;
    const textCodec = require("./text-codec.js");
    const netCore = require("./net-core.js");
    const netHelper = require("./net-helper-core.js");
    const textDecoder = new textCodec.TextDecoder("utf-8");
    const textEncoder = new textCodec.TextEncoder();

    // -------------------------------------------------- internal helpers

    function abToStr(buf) {
        return textDecoder.decode(new Uint8Array(buf));
    }

    // --------------------------------------------- internal HTTP parsing
    // Exported via globalThis.http_internal for websocket.js to reuse.

    /**
     * Read HTTP header lines from reader until the empty line (end of
     * headers). Returns { lines: string[], ok: boolean }. Enforces an
     * 8192-byte header size limit (matching original LIMIT).
     */
    async function recvHeader(reader) {
        const lines = [];
        let total = 0;
        while (true) {
            const line = await reader.readline();
            total += line.length + 2;   // +2 for the consumed CRLF
            if (total > LIMIT) {
                return { lines, ok: false };
            }
            if (line === "") {
                break;
            }
            lines.push(line);
        }
        return { lines, ok: true };
    }

    /**
     * Parse "Name: Value" header lines starting at index `from`.
     * Header names are lowercased. TAB/space continuation lines are
     * appended. Duplicate headers are merged into arrays. Returns the
     * header object, or null on malformed input.
     */
    function parseHeader(lines, from, header) {
        if (!header) header = {};
        let name = null;
        for (let i = from; i < lines.length; i++) {
            const line = lines[i];
            const ch = line.charCodeAt(0);
            if (ch === 9 || ch === 32) {
                // line folding (TAB or SPACE continuation)
                if (name === null) return null;
                header[name] = header[name] + line.substring(1);
            } else {
                const colon = line.indexOf(":");
                if (colon < 0) return null;
                name = line.substring(0, colon).toLowerCase();
                const value = line.substring(colon + 1).trimStart();
                if (header[name] !== undefined) {
                    const old = header[name];
                    if (Array.isArray(old)) {
                        old.push(value);
                    } else {
                        header[name] = [old, value];
                    }
                } else {
                    header[name] = value;
                }
            }
        }
        return header;
    }

    /**
     * Read a chunked transfer-encoding body. Loops reading hex chunk-size
     * lines -> chunk data -> trailing CRLF -> repeat until size 0. Parses
     * trailer headers. Enforces bodylimit. Returns { body, header } or
     * null on error.
     */
    async function recvChunkedBody(reader, bodylimit, header) {
        const parts = [];
        let size = 0;
        while (true) {
            const sizeLine = await reader.readline();
            // chunk-size may have extensions after semicolon; ignore them
            const semi = sizeLine.indexOf(";");
            const szStr = semi >= 0 ? sizeLine.substring(0, semi) : sizeLine;
            const sz = parseInt(szStr, 16);
            if (isNaN(sz)) return null;
            if (sz === 0) break;
            size += sz;
            if (bodylimit && size > bodylimit) return null;
            const chunkBuf = await reader.read(sz);
            parts.push(abToStr(chunkBuf));
            // consume trailing CRLF after chunk data
            await reader.read(2);
        }
        // parse trailer headers (after the last 0-sized chunk)
        const trailer = await recvHeader(reader);
        if (trailer.ok && trailer.lines.length > 0) {
            header = parseHeader(trailer.lines, 0, header || {});
        }
        return { body: parts.join(""), header: header };
    }

    /**
     * Read body based on content-length / status code / transfer-encoding.
     * For responses with no content-length and no chunked encoding (e.g.
     * HTTP/1.0 close-delimited), attempts to read until socket close.
     */
    async function recvBody(reader, code, header) {
        const lengthStr = header["content-length"];
        let length = null;
        if (lengthStr !== undefined) {
            length = parseInt(lengthStr, 10);
            if (isNaN(length)) length = null;
        }
        if (length !== null) {
            if (length === 0) return "";
            const buf = await reader.read(length);
            return abToStr(buf);
        } else if (code === 204 || code === 304 || code < 200) {
            return "";
        } else {
            // no content-length: read until connection close (HTTP/1.0
            // style). drain any buffered data, then keep reading until
            // socket_error (close).
            const parts = [];
            // drain already-buffered bytes
            if (reader.total > 0) {
                const buf = await reader.read(reader.total);
                parts.push(abToStr(buf));
            }
            // read more until the socket closes
            try {
                while (!reader.closed) {
                    const line = await reader.readline();
                    parts.push(line);
                    parts.push("\r\n");
                }
            } catch (e) {
                if (e !== netHelper.socketError) throw e;
                // socket closed: drain remaining buffered data
                if (reader.total > 0) {
                    try {
                        const remaining = reader._consume(reader.total);
                        parts.push(abToStr(remaining));
                    } catch (_) {
                        // ignore
                    }
                }
            }
            return parts.join("");
        }
    }

    // ---------------------------------------------- HTTP status code table

    const httpStatusMsg = {
        100: "Continue",
        101: "Switching Protocols",
        200: "OK",
        201: "Created",
        202: "Accepted",
        203: "Non-Authoritative Information",
        204: "No Content",
        205: "Reset Content",
        206: "Partial Content",
        300: "Multiple Choices",
        301: "Moved Permanently",
        302: "Found",
        303: "See Other",
        304: "Not Modified",
        305: "Use Proxy",
        307: "Temporary Redirect",
        400: "Bad Request",
        401: "Unauthorized",
        402: "Payment Required",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        406: "Not Acceptable",
        407: "Proxy Authentication Required",
        408: "Request Time-out",
        409: "Conflict",
        410: "Gone",
        411: "Length Required",
        412: "Precondition Failed",
        413: "Request Entity Too Large",
        414: "Request-URI Too Large",
        415: "Unsupported Media Type",
        416: "Requested range not satisfiable",
        417: "Expectation Failed",
        500: "Internal Server Error",
        501: "Not Implemented",
        502: "Bad Gateway",
        503: "Service Unavailable",
        504: "Gateway Time-out",
        505: "HTTP Version not supported",
    };

    // ========================================================== httpd
    //
    // HTTP server: read_request parses an incoming HTTP request from a
    // BufferedReader; write_response sends an HTTP response.

    const httpdObj = {};

    /**
     * Read and parse an HTTP request from `reader`.
     * Returns { code, url?, method?, header?, body? }.
     * On success code === 200; on error code is the HTTP error status.
     */
    httpdObj.readRequest = async function (reader, bodylimit) {
        try {
            const hdr = await recvHeader(reader);
            if (!hdr.ok) return { code: 413 };
            if (hdr.lines.length === 0) return { code: 400 };

            // parse request line: "METHOD URL HTTP/VERSION"
            const requestLine = hdr.lines[0];
            const match = requestLine.match(
                /^([A-Za-z]+)\s+(.*?)\s+HTTP\/(\d+\.\d+)$/
            );
            if (!match) return { code: 400 };

            const method = match[1];
            const url = match[2];
            const httpver = parseFloat(match[3]);
            if (httpver < 1.0 || httpver > 1.1) return { code: 505 };

            const header = parseHeader(hdr.lines, 1, {});
            if (!header) return { code: 400 };

            const mode = header["transfer-encoding"];
            if (mode && mode !== "identity" && mode !== "chunked") {
                return { code: 501 };
            }

            let body = "";
            if (mode === "chunked") {
                const result = await recvChunkedBody(
                    reader, bodylimit, header
                );
                if (!result) return { code: 413 };
                body = result.body;
            } else {
                const lengthStr = header["content-length"];
                if (lengthStr !== undefined) {
                    const length = parseInt(lengthStr, 10);
                    if (bodylimit && length > bodylimit) return { code: 413 };
                    if (length > 0) {
                        const buf = await reader.read(length);
                        body = abToStr(buf);
                    }
                }
            }

            return { code: 200, url, method, header, body };
        } catch (e) {
            if (e === netHelper.socketError) return { code: 400 };
            return { code: 400 };
        }
    };

    /**
     * Write an HTTP response.
     *   write_fn(data): write function (string or ArrayBuffer)
     *   statuscode: numeric HTTP status
     *   body: string (full body), function (chunked generator), or null
     *   header: object of name→value (value may be array for multi-value)
     * Returns true on success, false on write error.
     */
    httpdObj.writeResponse = function (writeFn, statuscode, body, header) {
        try {
            const codeStr = String(statuscode);
            const padded = codeStr.length < 3
                ? ("000" + codeStr).slice(-3)
                : codeStr;
            let head = "HTTP/1.1 " + padded + " " +
                (httpStatusMsg[statuscode] || "") + "\r\n";

            if (header) {
                const keys = Object.keys(header);
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    const v = header[k];
                    if (Array.isArray(v)) {
                        for (let j = 0; j < v.length; j++) {
                            head += k + ": " + v[j] + "\r\n";
                        }
                    } else {
                        head += k + ": " + v + "\r\n";
                    }
                }
            }

            if (typeof body === "string") {
                const bodyBytes = textEncoder.encode(body);
                head += "content-length: " + bodyBytes.byteLength +
                    "\r\n\r\n";
                writeFn(head);
                writeFn(body);
            } else if (typeof body === "function") {
                head += "transfer-encoding: chunked\r\n";
                writeFn(head);
                while (true) {
                    const chunk = body();
                    if (chunk !== null && chunk !== undefined) {
                        if (chunk !== "") {
                            const chunkBytes = textEncoder.encode(chunk);
                            writeFn("\r\n" +
                                chunkBytes.byteLength.toString(16) +
                                "\r\n");
                            writeFn(chunk);
                        }
                    } else {
                        writeFn("\r\n0\r\n\r\n");
                        break;
                    }
                }
            } else {
                // null/undefined: headers only, end with blank line
                head += "\r\n";
                writeFn(head);
            }
            return true;
        } catch (e) {
            return false;
        }
    };

    // ========================================================== httpc
    //
    // HTTP client with Keep-Alive connection pool.

    // --------------------------------------------- connection pool

    const connPool = new Map();   // key -> [{ fd, reader, expire_time }]
    const MAX_PER_HOST = 8;
    const DEFAULT_KEEPALIVE_SEC = 60;
    let cleanupTimerStarted = false;

    function poolKeyStr(host, port, protocol) {
        return host + ":" + port + ":" + protocol;
    }

    /**
     * Take a reusable connection from the pool. Validates expiry and
     * closed state. Returns { fd, reader } or null.
     */
    function poolGet(key) {
        const conns = connPool.get(key);
        if (!conns) return null;
        while (conns.length > 0) {
            const conn = conns.pop();
            if (!conn.reader.closed && skynet.now() < conn.expireTime) {
                return conn;
            }
            // expired or closed — discard silently
            try { netCore.close(conn.fd); } catch (_) { /* ignore */ }
        }
        connPool.delete(key);
        return null;
    }

    /**
     * Return a connection to the pool (or close it if not reusable).
     * Checks Connection: close header and parses Keep-Alive timeout.
     */
    function poolPut(key, fd, reader, respHeader) {
        // "Connection: close" means the server will close the connection
        const connHdr = respHeader ? respHeader["connection"] : null;
        if (typeof connHdr === "string" &&
            connHdr.toLowerCase() === "close") {
            try { netCore.close(fd); } catch (_) { /* ignore */ }
            return;
        }

        // parse Keep-Alive: timeout=N
        let timeoutSec = DEFAULT_KEEPALIVE_SEC;
        const kaHdr = respHeader ? respHeader["keep-alive"] : null;
        if (typeof kaHdr === "string") {
            const m = kaHdr.match(/timeout\s*=\s*(\d+)/i);
            if (m) timeoutSec = parseInt(m[1], 10);
        }

        // skynet.now() is centiseconds (10ms ticks)
        const expireTime = skynet.now() + timeoutSec * 100;

        let conns = connPool.get(key);
        if (!conns) {
            conns = [];
            connPool.set(key, conns);
        }

        // cap per-host connections: evict oldest if full
        while (conns.length >= MAX_PER_HOST) {
            const oldest = conns.shift();
            try { netCore.close(oldest.fd); } catch (_) { /* ignore */ }
        }

        conns.push({ fd, reader, expireTime });
        ensureCleanupTimer();
    }

    function ensureCleanupTimer() {
        if (cleanupTimerStarted) return;
        cleanupTimerStarted = true;
        scheduleCleanup();
    }

    function scheduleCleanup() {
        // 30 seconds = 3000 centiseconds
        skynet.timeout(3000, function () {
            const now = skynet.now();
            for (const [key, conns] of connPool) {
                for (let i = conns.length - 1; i >= 0; i--) {
                    const c = conns[i];
                    if (c.reader.closed || now >= c.expireTime) {
                        try { netCore.close(c.fd); } catch (_) { /* ignore */ }
                        conns.splice(i, 1);
                    }
                }
                if (conns.length === 0) connPool.delete(key);
            }
            if (connPool.size > 0) {
                scheduleCleanup();
            } else {
                cleanupTimerStarted = false;
            }
        });
    }

    // --------------------------------------------- URL utilities

    const defaultPort = { http: 80, https: 443 };

    function parseHostPart(host) {
        const colon1 = host.indexOf(":");
        if (colon1 < 0) {
            return { hostname: host, port: null };
        }
        // more than one colon → IPv6
        if (host.indexOf(":", colon1 + 1) >= 0) {
            const m = host.match(/^\[(.+?)\]:?(\d*)$/);
            if (m) {
                return {
                    hostname: m[1],
                    port: m[2] ? parseInt(m[2], 10) : null,
                };
            }
            throw new Error(
                "Invalid host: bare IPv6 address '" + host +
                "', use '[" + host + "]' instead"
            );
        }
        // single colon → host:port
        const m = host.match(/^(.*?):(\d+)$/);
        if (m) {
            return { hostname: m[1], port: parseInt(m[2], 10) };
        }
        return { hostname: host, port: null };
    }

    /**
     * Parse a full URL like "http://host:port/path" into its components.
     * Returns { protocol, host, port, path, host_header }.
     */
    function clientParseUrl(url) {
        let protocol, rest;
        const protoMatch = url.match(/^([a-zA-Z]+):\/\/(.*)/);
        if (protoMatch) {
            protocol = protoMatch[1].toLowerCase();
            rest = protoMatch[2];
        } else {
            protocol = "http";
            rest = url;
        }
        // separate path from host
        const slash = rest.indexOf("/");
        let hostPart, path;
        if (slash >= 0) {
            hostPart = rest.substring(0, slash);
            path = rest.substring(slash);
        } else {
            hostPart = rest;
            path = "/";
        }
        const parsed = parseHostPart(hostPart);
        const port = parsed.port || defaultPort[protocol];
        if (!port) throw new Error("Invalid protocol: " + protocol);
        return {
            protocol,
            host: parsed.hostname,
            port,
            path,
            hostHeader: hostPart,
        };
    }

    function httpcEscape(s) {
        let out = "";
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if ((c >= 65 && c <= 90) ||   // A-Z
                (c >= 97 && c <= 122) ||   // a-z
                (c >= 48 && c <= 57) ||    // 0-9
                c === 95 ||                // _
                c === 45 ||                // -
                c === 46 ||                // .
                c === 126) {               // ~
                out += s[i];
            } else {
                // encode each UTF-8 byte as %XX
                const bytes = textEncoder.encode(s[i]);
                for (let j = 0; j < bytes.length; j++) {
                    out += "%" +
                        bytes[j].toString(16).toUpperCase().padStart(2, "0");
                }
            }
        }
        return out;
    }

    function urlDecode(str) {
        str = str.replace(/\+/g, " ");
        const bytes = [];
        for (let i = 0; i < str.length; i++) {
            if (str[i] === "%" && i + 2 < str.length) {
                bytes.push(parseInt(str.substring(i + 1, i + 3), 16));
                i += 2;
            } else {
                bytes.push(str.charCodeAt(i));
            }
        }
        return new textCodec.TextDecoder().decode(new Uint8Array(bytes));
    }

    function httpcUrlParse(url) {
        const qmark = url.indexOf("?");
        if (qmark >= 0) {
            return {
                path: urlDecode(url.substring(0, qmark)),
                query: url.substring(qmark + 1),
            };
        }
        return { path: urlDecode(url), query: "" };
    }

    function httpcUrlParseQuery(q) {
        const r = {};
        if (!q) return r;
        const pairs = q.split("&");
        for (let i = 0; i < pairs.length; i++) {
            const eq = pairs[i].indexOf("=");
            if (eq < 0) continue;
            const dk = urlDecode(pairs[i].substring(0, eq));
            const dv = urlDecode(pairs[i].substring(eq + 1));
            if (r[dk] !== undefined) {
                if (Array.isArray(r[dk])) {
                    r[dk].push(dv);
                } else {
                    r[dk] = [r[dk], dv];
                }
            } else {
                r[dk] = dv;
            }
        }
        return r;
    }

    // --------------------------------------------- client internals

    /**
     * Build the HTTP request header string and optional body. Matches the
     * original internal.request() layout.
     */
    function buildRequest(method, hostHeader, url, header, content) {
        let headerContent = "";
        if (header) {
            let hasHost = false;
            const keys = Object.keys(header);
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (k.toLowerCase() === "host") hasHost = true;
                const v = header[k];
                if (Array.isArray(v)) {
                    for (let j = 0; j < v.length; j++) {
                        headerContent += k + ":" + v[j] + "\r\n";
                    }
                } else {
                    headerContent += k + ":" + v + "\r\n";
                }
            }
            if (!hasHost) {
                headerContent = "Host:" + hostHeader + "\r\n" +
                    headerContent;
            }
        } else {
            headerContent = "Host:" + hostHeader + "\r\n";
        }

        let requestHead;
        if (content !== undefined && content !== null && content !== "") {
            if (header &&
                header["transfer-encoding"] === "chunked") {
                requestHead = method + " " + url + " HTTP/1.1\r\n" +
                    headerContent + "\r\n";
            } else {
                const contentBytes = (typeof content === "string")
                    ? textEncoder.encode(content)
                    : content;
                requestHead = method + " " + url + " HTTP/1.1\r\n" +
                    headerContent +
                    "Content-length:" + contentBytes.byteLength +
                    "\r\n\r\n";
            }
        } else {
            requestHead = method + " " + url + " HTTP/1.1\r\n" +
                headerContent + "Content-length:0\r\n\r\n";
        }
        return requestHead;
    }

    /**
     * Perform an HTTP request over an existing reader. Returns
     * { status, body, header } or throws on error.
     */
    async function doRequestOn(reader, method, hostHeader, url,
        recvHeaderOut, header, content) {
        // send request
        const requestHead = buildRequest(
            method, hostHeader, url, header, content
        );
        reader.write(requestHead);
        if (content !== undefined && content !== null && content !== "") {
            reader.write(content);
        }

        // receive response headers
        const hdr = await recvHeader(reader);
        if (!hdr.ok || hdr.lines.length === 0) {
            throw new Error("Recv header failed");
        }

        // parse status line "HTTP/x.x CODE INFO"
        const statusLine = hdr.lines[0];
        const sm = statusLine.match(/HTTP\/[\d.]+\s+(\d+)\s*(.*)/);
        if (!sm) throw new Error("Invalid HTTP status line");
        const statusCode = parseInt(sm[1], 10);

        const respHeader = parseHeader(
            hdr.lines, 1, recvHeaderOut || {}
        );
        if (!respHeader) throw new Error("Invalid HTTP response header");

        return { status: statusCode, header: respHeader };
    }

    /**
     * Open a new connection (with optional TLS upgrade).
     */
    async function openConnection(parsed, timeout, caFile) {
        const fd = await netHelper.connect(
            parsed.host, parsed.port, timeout
        );
        const reader = netHelper.reader(fd);

        if (parsed.protocol === "https") {
            if (!skynetcore.tls) {
                netCore.close(fd);
                throw new Error("HTTPS requires OpenSSL build");
            }
            await netHelper.tlsUpgrade(
                reader, parsed.host, false, null, null, caFile
            );
        }

        return { fd, reader };
    }

    // --------------------------------------------- httpc public API

    const httpcObj = {
        timeout: null,   // global timeout in skynet ticks (centiseconds)
    };

    /**
     * Full HTTP request. Returns Promise<{ status, body, header }>.
     * Supports connection pooling with retry-on-stale.
     */
    httpcObj.request = async function (method, hostname, url,
        recvHeaderOut, header, content, options) {
        const parsed = clientParseUrl(hostname);
        const key = poolKeyStr(parsed.host, parsed.port, parsed.protocol);
        const timeout = httpcObj.timeout || undefined;
        const caFile = (options && options.caFile) || undefined;

        let fd, reader, fromPool = false;
        const pooled = poolGet(key);
        if (pooled) {
            fd = pooled.fd;
            reader = pooled.reader;
            fromPool = true;
        }

        // retry-on-stale: if pooled connection fails on first write,
        // open a fresh one and retry (max 1 retry)
        for (let attempt = 0; attempt < 2; attempt++) {
            if (!fromPool || attempt > 0) {
                const conn = await openConnection(parsed, timeout, caFile);
                fd = conn.fd;
                reader = conn.reader;
                fromPool = false;
            }

            try {
                const result = await doRequestOn(
                    reader, method, parsed.hostHeader, url,
                    recvHeaderOut, header, content
                );

                // read body
                const mode = result.header["transfer-encoding"];
                let body;
                if (method === "HEAD") {
                    body = "";
                } else if (mode && mode !== "identity" &&
                    mode === "chunked") {
                    const chunked = await recvChunkedBody(
                        reader, null, result.header
                    );
                    if (!chunked) throw new Error("Invalid response body");
                    body = chunked.body;
                } else {
                    body = await recvBody(
                        reader, result.status, result.header
                    );
                }

                // keep-alive decision
                const hasContentLength =
                    result.header["content-length"] !== undefined;
                const isChunked = mode === "chunked";
                const canPool = hasContentLength || isChunked ||
                    result.status === 204 || result.status === 304 ||
                    result.status < 200 || method === "HEAD";

                if (canPool) {
                    poolPut(key, fd, reader, result.header);
                } else {
                    try { netCore.close(fd); } catch (_) { /* ignore */ }
                }

                return {
                    status: result.status,
                    body: body,
                    header: result.header,
                };
            } catch (e) {
                // stale pooled connection: retry once with a fresh one
                if (fromPool && attempt === 0) {
                    try { netCore.close(fd); } catch (_) { /* ignore */ }
                    fromPool = false;
                    continue;
                }
                // real failure: close and rethrow
                try { netCore.close(fd); } catch (_) { /* ignore */ }
                throw e;
            }
        }
    };

    /**
     * HTTP GET shorthand.
     */
    httpcObj.get = async function (hostname, url, recvHeaderOut, header, options) {
        const r = await httpcObj.request(
            "GET", hostname, url, recvHeaderOut, header, undefined, options
        );
        return { status: r.status, body: r.body };
    };

    /**
     * HTTP POST with form-encoded body.
     */
    httpcObj.post = async function (hostname, url, form, recvHeaderOut, options) {
        const hdr = {
            "content-type": "application/x-www-form-urlencoded",
        };
        const parts = [];
        const keys = Object.keys(form);
        for (let i = 0; i < keys.length; i++) {
            parts.push(
                httpcEscape(keys[i]) + "=" + httpcEscape(String(form[keys[i]]))
            );
        }
        const body = parts.join("&");
        const r = await httpcObj.request(
            "POST", hostname, url, recvHeaderOut, hdr, body, options
        );
        return { status: r.status, body: r.body };
    };

    /**
     * HTTP HEAD — returns only the status code.
     */
    httpcObj.head = async function (hostname, url, recvHeaderOut,
        header, options) {
        const parsed = clientParseUrl(hostname);
        const key = poolKeyStr(parsed.host, parsed.port, parsed.protocol);
        const timeout = httpcObj.timeout || undefined;
        const caFile = (options && options.caFile) || undefined;

        for (let attempt = 0; attempt < 2; attempt++) {
            let fd, reader;
            const pooled = (attempt === 0) ? poolGet(key) : null;
            if (pooled) {
                fd = pooled.fd;
                reader = pooled.reader;
            } else {
                const conn = await openConnection(parsed, timeout, caFile);
                fd = conn.fd;
                reader = conn.reader;
            }

            try {
                const result = await doRequestOn(
                    reader, "HEAD", parsed.hostHeader, url,
                    recvHeaderOut, header
                );
                poolPut(key, fd, reader, result.header);
                return result.status;
            } catch (e) {
                try { netCore.close(fd); } catch (_) { /* ignore */ }
                if (!pooled || attempt > 0) throw e;
                // stale pooled connection, retry with fresh
            }
        }
    };

    /**
     * Streaming HTTP request. Returns a stream object with read() method.
     */
    httpcObj.requestStream = async function (method, hostname, url,
        recvHeaderOut, header, content) {
        const parsed = clientParseUrl(hostname);
        const timeout = httpcObj.timeout || undefined;

        const conn = await openConnection(parsed, timeout);
        const fd = conn.fd;
        const reader = conn.reader;

        try {
            const result = await doRequestOn(
                reader, method, parsed.hostHeader, url,
                recvHeaderOut, header, content
            );

            const mode = result.header["transfer-encoding"];
            const isChunked = mode === "chunked";
            const lengthStr = result.header["content-length"];
            let remaining = lengthStr !== undefined
                ? parseInt(lengthStr, 10)
                : null;
            const status = result.status;

            // build stream object
            const key = poolKeyStr(
                parsed.host, parsed.port, parsed.protocol
            );

            function finishStream() {
                stream._closed = true;
                stream.connected = false;
                // return to pool if connection looks reusable
                const connHdr = result.header
                    ? result.header["connection"] : null;
                const isClose = typeof connHdr === "string" &&
                    connHdr.toLowerCase() === "close";
                if (!isClose && !reader.closed) {
                    poolPut(key, fd, reader, result.header);
                } else {
                    try { netCore.close(fd); } catch (_) { /* ignore */ }
                }
            }

            const stream = {
                status: status,
                header: result.header,
                connected: true,
                _closed: false,

                /** Read next chunk. Returns string or null when done. */
                read: async function () {
                    if (stream._closed) return null;
                    if (isChunked) {
                        const sizeLine = await reader.readline();
                        const semi = sizeLine.indexOf(";");
                        const szStr = semi >= 0
                            ? sizeLine.substring(0, semi)
                            : sizeLine;
                        const sz = parseInt(szStr, 16);
                        if (isNaN(sz) || sz === 0) {
                            // last chunk: parse trailers
                            const trailer = await recvHeader(reader);
                            if (trailer.ok && trailer.lines.length > 0) {
                                parseHeader(
                                    trailer.lines, 0, stream.header
                                );
                            }
                            finishStream();
                            return null;
                        }
                        const buf = await reader.read(sz);
                        await reader.read(2);   // trailing CRLF
                        return abToStr(buf);
                    } else if (remaining !== null) {
                        if (remaining <= 0) {
                            finishStream();
                            return null;
                        }
                        const toRead = Math.min(remaining, 8192);
                        const buf = await reader.read(toRead);
                        remaining -= toRead;
                        if (remaining <= 0) {
                            finishStream();
                        }
                        return abToStr(buf);
                    } else {
                        // read-all mode: one shot
                        stream._closed = true;
                        stream.connected = false;
                        try { netCore.close(fd); } catch (_) { /* ignore */ }
                        return null;
                    }
                },

                close: function () {
                    if (!stream._closed) {
                        stream._closed = true;
                        stream.connected = false;
                        try { netCore.close(fd); } catch (_) { /* ignore */ }
                    }
                },
            };

            return stream;
        } catch (e) {
            try { netCore.close(fd); } catch (_) { /* ignore */ }
            throw e;
        }
    };

    httpcObj.escape = httpcEscape;
    httpcObj.urlParse = httpcUrlParse;
    httpcObj.urlParseQuery = httpcUrlParseQuery;
    httpcObj.parseUrl = function (url) {
        const p = clientParseUrl(url);
        return {
            protocol: p.protocol,
            host: p.host,
            port: p.port,
            path: p.path,
        };
    };

    httpcObj.closeAllKeepalive = function () {
        for (const [_key, conns] of connPool) {
            for (let i = 0; i < conns.length; i++) {
                try { netCore.close(conns[i].fd); } catch (_) { /* ignore */ }
            }
        }
        connPool.clear();
    };

    // ---------------------------------------- exports

    module.exports = {
        httpd: httpdObj,
        httpc: httpcObj,
        httpInternal: {
            recvHeader,
            parseHeader,
            recvChunkedBody,
            recvBody,
            httpStatusMsg,
        },
    };
})();
