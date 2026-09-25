"use strict";

// Global `fetch` (WHATWG subset) built on the same internal/http-core parser as
// the http/https facades (§16.6). No separate HTTP stack.

const http = require("./http.js");
const https = require("./https.js");
const url = require("./url.js");
const errors = require("../internal/errors.js");

class Headers {
    constructor(init) {
        this._map = new Map();
        if (init instanceof Headers) {
            for (const [k, v] of init.entries()) this.set(k, v);
        } else if (Array.isArray(init)) {
            for (const [k, v] of init) this.set(k, v);
        } else if (init && typeof init === "object") {
            for (const [k, v] of Object.entries(init)) this.set(k, v);
        }
    }
    set(name, value) { this._map.set(String(name).toLowerCase(), String(value)); }
    get(name) { const v = this._map.get(String(name).toLowerCase()); return v === undefined ? null : v; }
    has(name) { return this._map.has(String(name).toLowerCase()); }
    delete(name) { this._map.delete(String(name).toLowerCase()); }
    entries() { return this._map.entries(); }
    keys() { return this._map.keys(); }
    values() { return this._map.values(); }
    forEach(cb, thisArg) { for (const [k, v] of this._map) cb.call(thisArg, v, k, this); }
    [Symbol.iterator]() { return this.entries(); }
}

class Response {
    constructor(body, init) {
        const opts = init || {};
        this.status = opts.status === undefined ? 200 : opts.status;
        this.statusText = opts.statusText || "";
        this.ok = this.status >= 200 && this.status < 300;
        this.headers = new Headers(opts.headers);
        this.url = opts.url || "";
        this.redirected = false;
        this.type = "basic";
        this.bodyUsed = false;
        this._body = body === undefined || body === null ? Buffer.alloc(0) :
            (Buffer.isBuffer(body) ? body : Buffer.from(body));
    }

    async text() { this.bodyUsed = true; return this._body.toString("utf8"); }
    async json() { this.bodyUsed = true; return JSON.parse(this._body.toString("utf8")); }
    async arrayBuffer() {
        this.bodyUsed = true;
        return this._body.buffer.slice(this._body.byteOffset,
            this._body.byteOffset + this._body.byteLength);
    }
    async blob() { this.bodyUsed = true; return new Blob([this._body]); }
    clone() { return new Response(this._body, { status: this.status, headers: this.headers }); }
}

function normalizeBody(body) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === "string") return body;
    if (body instanceof ArrayBuffer) return Buffer.from(body);
    if (ArrayBuffer.isView(body)) {
        return Buffer.from(body.buffer.slice(body.byteOffset,
            body.byteOffset + body.byteLength));
    }
    if (body instanceof URLSearchParams) return body.toString();
    return String(body);
}

async function fetch(input, init) {
    const opts = init || {};
    const parsed = typeof input === "string" ? new URL(input) :
        (input instanceof URL ? input : new URL(String(input)));
    const isHttps = parsed.protocol === "https:";
    const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
    const path = (parsed.pathname || "/") + (parsed.search || "");

    const headers = {};
    const headerInit = opts.headers;
    if (headerInit instanceof Headers) {
        for (const [k, v] of headerInit.entries()) headers[k] = v;
    } else if (Array.isArray(headerInit)) {
        for (const [k, v] of headerInit) headers[k] = v;
    } else if (headerInit && typeof headerInit === "object") {
        Object.assign(headers, headerInit);
    }

    const body = normalizeBody(opts.body);
    if (body !== undefined && headers["content-length"] === undefined) {
        headers["content-length"] = String(Buffer.byteLength(body));
    }

    const transport = isHttps ? https : http;
    const response = await transport.request({
        hostname: parsed.hostname,
        port,
        path,
        method: opts.method || "GET",
        headers,
        body,
    });
    return new Response(response.body, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers: response.headers,
        url: parsed.href,
    });
}

function install() {
    if (typeof globalThis.fetch === "undefined") {
        globalThis.fetch = fetch;
        globalThis.Headers = Headers;
        globalThis.Response = Response;
        globalThis.Request = class Request {
            constructor(input, init) {
                this.url = String(input);
                this.method = (init && init.method) || "GET";
                this.headers = new Headers(init && init.headers);
                this.body = init && init.body;
            }
        };
    }
}

module.exports = { fetch, Headers, Response, install };
