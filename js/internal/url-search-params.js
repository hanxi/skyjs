"use strict";

// WHATWG URLSearchParams. QuickJS-ng does not ship it, so this provides the
// subset Node/WHATWG require, used by builtins/url.js and fetch-style code.

function encodeComponent(value) {
    return encodeURIComponent(String(value))
        .replace(/%20/g, "+")
        .replace(/[!'()~]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
}

function decodeComponent(value) {
    try {
        return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch (err) {
        return String(value);
    }
}

class URLSearchParams {
    constructor(init) {
        this._entries = [];
        if (init === undefined || init === null) return;
        if (typeof init === "string") {
            this._parse(init);
        } else if (init instanceof URLSearchParams) {
            this._entries = init._entries.map((pair) => pair.slice());
        } else if (Array.isArray(init)) {
            for (const pair of init) {
                if (pair.length !== 2) {
                    throw new TypeError(
                        "Each query pair must be an iterable [name, value] tuple");
                }
                this.append(pair[0], pair[1]);
            }
        } else if (typeof init === "object") {
            for (const key of Object.keys(init)) this.append(key, init[key]);
        }
    }

    _parse(text) {
        const stripped = text.startsWith("?") ? text.slice(1) : text;
        if (stripped === "") return;
        for (const part of stripped.split("&")) {
            if (part === "") continue;
            const index = part.indexOf("=");
            if (index < 0) {
                this._entries.push([decodeComponent(part), ""]);
            } else {
                this._entries.push([
                    decodeComponent(part.slice(0, index)),
                    decodeComponent(part.slice(index + 1)),
                ]);
            }
        }
    }

    get size() {
        return this._entries.length;
    }

    append(name, value) {
        this._entries.push([String(name), String(value)]);
    }

    delete(name, value) {
        const key = String(name);
        this._entries = this._entries.filter((pair) => {
            if (pair[0] !== key) return true;
            return value !== undefined && pair[1] !== String(value);
        });
    }

    get(name) {
        const key = String(name);
        for (const pair of this._entries) {
            if (pair[0] === key) return pair[1];
        }
        return null;
    }

    getAll(name) {
        const key = String(name);
        return this._entries.filter((pair) => pair[0] === key)
            .map((pair) => pair[1]);
    }

    has(name, value) {
        const key = String(name);
        return this._entries.some((pair) => pair[0] === key &&
            (value === undefined || pair[1] === String(value)));
    }

    set(name, value) {
        const key = String(name);
        const text = String(value);
        let replaced = false;
        const next = [];
        for (const pair of this._entries) {
            if (pair[0] !== key) {
                next.push(pair);
            } else if (!replaced) {
                next.push([key, text]);
                replaced = true;
            }
        }
        if (!replaced) next.push([key, text]);
        this._entries = next;
    }

    sort() {
        this._entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    }

    forEach(callback, thisArg) {
        for (const [key, value] of this._entries) {
            callback.call(thisArg, value, key, this);
        }
    }

    entries() { return this._entries[Symbol.iterator](); }
    keys() { return this._entries.map((pair) => pair[0])[Symbol.iterator](); }
    values() { return this._entries.map((pair) => pair[1])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }

    toString() {
        return this._entries.map(([key, value]) =>
            encodeComponent(key) + "=" + encodeComponent(value)).join("&");
    }
}

module.exports = { URLSearchParams };
