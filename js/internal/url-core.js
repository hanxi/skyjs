"use strict";

// Minimal WHATWG URL parser covering the http/https/ws/wss/file/ftp shapes the
// runtime needs (fetch/net/http facades). Not a full URL Standard impl: no
// IDNA, no punycode, no percent-encoding normalization beyond what URLs carry.

const urlSearchParams = require("./url-search-params.js");

const SPECIAL = {
    "http:": 80, "https:": 443, "ws:": 80, "wss:": 443, "ftp:": 21,
};

function isSpecial(protocol) {
    return Object.prototype.hasOwnProperty.call(SPECIAL, protocol);
}

class URL {
    constructor(input, base) {
        const text = String(input);
        let parsed;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
            parsed = parseAbsolute(text);
        } else if (base !== undefined) {
            parsed = resolveAgainst(new URL(base), text);
        } else {
            throw new TypeError("Invalid URL: " + text);
        }
        if (parsed === null) throw new TypeError("Invalid URL: " + text);
        this._apply(parsed);
    }

    _apply(parsed) {
        this.protocol = parsed.protocol;
        this.host = parsed.host;
        this.hostname = parsed.hostname;
        this.port = parsed.port;
        this.pathname = parsed.pathname;
        this._search = parsed.search;
        this.hash = parsed.hash;
        this.username = parsed.username;
        this.password = parsed.password;
        this._refreshSearchParams();
    }

    _refreshSearchParams() {
                // `this._search` keeps the exact raw query text (Node preserves "?y"
        // without appending "="); searchParams is the structured view.
        this.searchParams = new urlSearchParams.URLSearchParams(this._search.startsWith("?") ?
            this._search.slice(1) : this._search);
        const originalToString = this.searchParams.toString.bind(this.searchParams);
        for (const method of ["append", "delete", "set", "sort"]) {
            const original = this.searchParams[method].bind(this.searchParams);
            this.searchParams[method] = (...args) => {
                original(...args);
                const text = originalToString();
                this._search = text === "" ? "" : "?" + text;
            };
        }
    }

    get search() {
        return this._search;
    }

    set search(value) {
        const text = String(value);
        this._search = text === "" ? "" : (text.startsWith("?") ? text : "?" + text);
                this.searchParams = new urlSearchParams.URLSearchParams(this._search.slice(1));
        this._refreshSearchParams();
    }

    get href() {
        return formatUrl(this);
    }

    set href(value) {
        this._apply(new URL(value));
    }

    get origin() {
        if (!isSpecial(this.protocol)) return "null";
        return this.protocol + "//" + this.host;
    }

    toString() {
        return this.href;
    }

    toJSON() {
        return this.href;
    }

    static canParse(input, base) {
        try {
            new URL(input, base);
            return true;
        } catch (err) {
            return false;
        }
    }
}

function parseAbsolute(text) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/
        .exec(text);
    if (match === null) return null;
    const protocol = match[1].toLowerCase();
    const authority = match[2] === undefined ? null : match[2];
    let username = "";
    let password = "";
    let hostname = "";
    let port = "";

    if (authority !== null) {
        let hostPart = authority;
        const at = hostPart.lastIndexOf("@");
        if (at >= 0) {
            const userInfo = hostPart.slice(0, at);
            hostPart = hostPart.slice(at + 1);
            const colon = userInfo.indexOf(":");
            if (colon >= 0) {
                username = userInfo.slice(0, colon);
                password = userInfo.slice(colon + 1);
            } else {
                username = userInfo;
            }
        }
        if (hostPart.startsWith("[")) {
            const close = hostPart.indexOf("]");
            hostname = hostPart.slice(0, close + 1);
            if (hostPart[close + 1] === ":") port = hostPart.slice(close + 2);
        } else {
            const colon = hostPart.lastIndexOf(":");
            if (colon >= 0) {
                hostname = hostPart.slice(0, colon);
                port = hostPart.slice(colon + 1);
            } else {
                hostname = hostPart;
            }
        }
        hostname = hostname.toLowerCase();
    }

    if (isSpecial(protocol) && String(SPECIAL[protocol]) === port) port = "";
    const defaultPath = (authority !== null && isSpecial(protocol)) ? "/" : "";
    return {
        protocol,
        hostname,
        port,
        username,
        password,
        host: hostname + (port === "" ? "" : ":" + port),
        pathname: match[3] === "" ? defaultPath : normalizePath(match[3]),
        search: match[4] || "",
        hash: match[5] || "",
    };
}

function normalizePath(pathname) {
    const parts = [];
    for (const part of pathname.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
    }
    const trailing = pathname.endsWith("/") || pathname.endsWith("/.") ||
        pathname.endsWith("/..");
    let out = "/" + parts.join("/");
    if (trailing && out !== "/") out += "/";
    return out;
}

function resolveAgainst(base, relative) {
    if (relative === "") return stripHash(base);
    if (relative.startsWith("#")) {
        const out = stripHash(base);
        out.hash = relative;
        return out;
    }
    if (relative.startsWith("?")) {
        const out = stripHash(base);
        out.search = relative;
        return out;
    }
    if (relative.startsWith("//")) {
        const parsed = parseAbsolute(base.protocol + relative);
        return parsed;
    }
    const out = stripHash(base);
    out.search = "";
    if (relative.startsWith("/")) {
        out.pathname = normalizePath(relative);
        return out;
    }
    const basePath = out.pathname.endsWith("/") ? out.pathname :
        out.pathname.slice(0, out.pathname.lastIndexOf("/") + 1);
    const merged = basePath + relative;
    const hashIndex = merged.indexOf("#");
    const searchIndex = merged.indexOf("?");
    let path = merged;
    let search = "";
    let hash = "";
    if (hashIndex >= 0) { hash = merged.slice(hashIndex); path = path.slice(0, hashIndex); }
    if (searchIndex >= 0 && (hashIndex < 0 || searchIndex < hashIndex)) {
        search = path.slice(searchIndex, hashIndex >= 0 ? hashIndex : undefined);
        path = path.slice(0, searchIndex);
    }
    out.pathname = normalizePath(path);
    out.search = search;
    out.hash = hash;
    return out;
}

function stripHash(base) {
    return {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        host: base.host,
        username: base.username,
        password: base.password,
        pathname: base.pathname,
        search: base.search,
        hash: "",
    };
}

function formatUrl(url) {
    let out = url.protocol;
    if (url.host !== "") {
        out += "//";
        if (url.username !== "" || url.password !== "") {
            out += url.username + (url.password !== "" ? ":" + url.password : "") + "@";
        }
        out += url.host;
    }
    out += url.pathname;
    out += url.search;
    out += url.hash;
    return out;
}

module.exports = { URL, URLSearchParams: urlSearchParams.URLSearchParams };
