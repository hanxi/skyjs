"use strict";

// Node `http` facade: createServer/Server/IncomingMessage/ServerResponse plus
// request/get, over internal/http-core (the same parser httpd/httpc use).

const { EventEmitter } = require("./events.js");
const net = require("./net.js");
const stream = require("./stream/index.js");
const httpCore = require("../internal/http-core.js");
const errors = require("../internal/errors.js");
const url = require("./url.js");

const STATUS_CODES = {
    200: "OK", 201: "Created", 204: "No Content", 206: "Partial Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 408: "Request Timeout",
    413: "Payload Too Large", 500: "Internal Server Error",
    501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
};

class IncomingMessage extends stream.Readable {
    constructor(socket) {
        super({ read() {} });
        this.socket = socket;
        this.httpVersion = "1.1";
        this.httpVersionMajor = 1;
        this.httpVersionMinor = 1;
        this.method = null;
        this.url = null;
        this.statusCode = null;
        this.statusMessage = null;
        this.headers = {};
        this.rawHeaders = [];
        this.complete = false;
        this.aborted = false;
    }

    setTimeout(ms, callback) {
        this._timeout = ms;
        if (typeof callback === "function") this.once("timeout", callback);
        return this;
    }

    destroy(err) {
        stream.Readable.prototype.destroy.call(this);
        if (err) this.emit("error", err);
        return this;
    }
}

class ServerResponse extends stream.Writable {
    constructor(req) {
        super({ write: (chunk, encoding, callback) => {
            this._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            callback();
        } });
        this.req = req;
        this.statusCode = 200;
        this.statusMessage = null;
        this.headersSent = false;
        this.finished = false;
        this._headers = {};
        this._chunks = [];
    }

    setHeader(name, value) {
        this._headers[String(name).toLowerCase()] = value;
        return this;
    }

    getHeader(name) {
        return this._headers[String(name).toLowerCase()];
    }

    removeHeader(name) {
        delete this._headers[String(name).toLowerCase()];
    }

    writeHead(statusCode, statusMessage, headers) {
        this.statusCode = statusCode;
        if (typeof statusMessage === "string") this.statusMessage = statusMessage;
        const extra = typeof statusMessage === "object" ? statusMessage : headers;
        if (extra) for (const [k, v] of Object.entries(extra)) this.setHeader(k, v);
        this.headersSent = true;
        return this;
    }

    _finish(err) {
        if (!this.headersSent) this.headersSent = true;
        if (err) {
            stream.Writable.prototype._finish.call(this, err);
            return;
        }
        const status = this.statusCode;
        const reason = this.statusMessage || STATUS_CODES[status] || "";
        const body = Buffer.concat(this._chunks);
        let head = "HTTP/1.1 " + status + " " + reason + "\r\n";
        const headers = Object.assign({
            "content-length": String(body.length),
            "connection": "keep-alive",
        }, this._headers);
        for (const [name, value] of Object.entries(headers)) {
            head += name + ": " + value + "\r\n";
        }
        head += "\r\n";
        const socket = this.req.socket;
        socket.write(head);
        if (body.length > 0) socket.write(body);
        this.finished = true;
        stream.Writable.prototype._finish.call(this, null);
    }
}

class Server extends EventEmitter {
    constructor(options, requestListener) {
        super();
        const opts = typeof options === "function" ? {} : (options || {});
        this._netServer = new net.Server(opts);
        this.timeout = opts.timeout || 0;
        this.listening = false;
        this._connections = new Set();
        if (typeof options === "function") this.on("request", options);
        if (typeof requestListener === "function") this.on("request", requestListener);
        this._netServer.on("connection", (socket) => this._handle(socket));
    }

    _handle(socket) {
        this._connections.add(socket);
        socket.on("close", () => this._connections.delete(socket));
        const reader = httpCore.httpInternal && socket;
        let buffer = Buffer.alloc(0);
        let pending = null;
        socket.on("data", (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            // Parse one request; the runtime's keep-alive loop re-enters here.
            const parsed = parseRequest(buffer);
            if (parsed === null) return;
            buffer = buffer.subarray(parsed.consumed);
            const req = new IncomingMessage(socket);
            req.method = parsed.method;
            req.url = parsed.url;
            req.headers = parsed.headers;
            req.rawHeaders = parsed.rawHeaders;
            req.httpVersion = parsed.version;
            if (parsed.body.length > 0) req.push(parsed.body);
            req.push(null);
            const res = new ServerResponse(req);
            this.emit("request", req, res);
        });
    }

    listen(...args) {
        const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
        if (callback) this.once("listening", callback);
        this._netServer.listen(...args);
        this._netServer.once("listening", () => {
            this.listening = true;
            this.emit("listening");
        });
        return this;
    }

    address() {
        return this._netServer.address();
    }

    close(callback) {
        if (callback) this.once("close", callback);
        for (const socket of this._connections) socket.destroy();
        this._netServer.close();
        this.listening = false;
        this.emit("close");
        return this;
    }

    setTimeout(ms, callback) {
        this.timeout = ms;
        if (typeof callback === "function") this.on("timeout", callback);
        return this;
    }
}

function parseRequest(buffer) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const head = buffer.subarray(0, headerEnd).toString("utf8");
    const lines = head.split("\r\n");
    const requestLine = /^([A-Z]+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(lines[0]);
    if (requestLine === null) return null;
    const headers = {};
    const rawHeaders = [];
    for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(":");
        if (colon < 0) continue;
        const name = lines[i].slice(0, colon).trim().toLowerCase();
        const value = lines[i].slice(colon + 1).trim();
        rawHeaders.push(lines[i].slice(0, colon).trim(), value);
        if (headers[name] === undefined) headers[name] = value;
        else if (Array.isArray(headers[name])) headers[name].push(value);
        else headers[name] = [headers[name], value];
    }
    const length = parseInt(headers["content-length"] || "0", 10);
    if (buffer.length - headerEnd - 4 < length) return null;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
    return {
        method: requestLine[1],
        url: requestLine[2],
        version: requestLine[3],
        headers,
        rawHeaders,
        body: Buffer.from(body),
        consumed: headerEnd + 4 + length,
    };
}

function createServer(options, requestListener) {
    return new Server(options, requestListener);
}

function request(options, callback) {
    const opts = typeof options === "string" ? url.parse(options) : options;
    const port = opts.port || (opts.protocol === "https:" ? 443 : 80);
    const host = opts.hostname || opts.host || "127.0.0.1";
    const path = opts.path || "/";
    const method = opts.method || "GET";
    const headers = opts.headers || {};

    return new Promise((resolve, reject) => {
        const socket = net.connect(port, host, () => {
            let head = method + " " + path + " HTTP/1.1\r\n";
            head += "host: " + host + "\r\n";
            head += "connection: close\r\n";
            for (const [k, v] of Object.entries(headers)) head += k + ": " + v + "\r\n";
            head += "\r\n";
            socket.write(head);
            if (opts.body) socket.write(opts.body);
        });
        let raw = Buffer.alloc(0);
        socket.on("data", (chunk) => { raw = Buffer.concat([raw, chunk]); });
        socket.on("end", () => {
            try {
                resolve(parseResponse(raw));
            } catch (err) {
                reject(err);
            }
        });
        socket.on("error", reject);
    });
}

function parseResponse(raw) {
    const headerEnd = raw.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
        throw errors.skyjsError("ERR_PROTOCOL", "malformed HTTP response");
    }
    const lines = raw.subarray(0, headerEnd).toString("utf8").split("\r\n");
    const statusLine = lines[0].split(" ");
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(":");
        if (colon < 0) continue;
        headers[lines[i].slice(0, colon).trim().toLowerCase()] =
            lines[i].slice(colon + 1).trim();
    }
    return {
        statusCode: parseInt(statusLine[1], 10),
        statusMessage: statusLine.slice(2).join(" "),
        headers,
        body: Buffer.from(raw.subarray(headerEnd + 4)),
    };
}

function get(options, callback) {
    return request(options, callback);
}

module.exports = {
    Server,
    IncomingMessage,
    ServerResponse,
    createServer,
    request,
    get,
    STATUS_CODES,
};
