"use strict";

// Node-compatible querystring facade. Matches Node 20 semantics: escape() is
// encodeURIComponent, undefined values stringify to the empty string, and
// repeated keys parse into arrays.

function escape(str) {
    return encodeURIComponent(String(str));
}

function unescape(str) {
    try {
        return decodeURIComponent(String(str));
    } catch (err) {
        return String(str);
    }
}

function stringify(obj, sep, eq, options) {
    const separator = sep === undefined ? "&" : sep;
    const equals = eq === undefined ? "=" : eq;
    const encode = (options && options.encodeURIComponent) || escape;
    if (obj === null || typeof obj !== "object") return "";

    const parts = [];
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        const encodedKey = encode(key);
        if (Array.isArray(value)) {
            for (const item of value) {
                parts.push(encodedKey + equals + encode(item));
            }
        } else {
            const text = value === undefined || value === null ? "" : value;
            parts.push(encodedKey + equals + encode(text));
        }
    }
    return parts.join(separator);
}

function parse(str, sep, eq, options) {
    const separator = sep === undefined ? "&" : sep;
    const equals = eq === undefined ? "=" : eq;
    const decode = (options && options.decodeURIComponent) || unescape;
    const result = Object.create(null);
    if (typeof str !== "string" || str.length === 0) return result;

    const maxKeys = options && options.maxKeys !== undefined ?
        options.maxKeys : 1000;
    let count = 0;
    for (const pair of str.split(separator)) {
        if (maxKeys > 0 && count >= maxKeys) break;
        if (pair === "") continue;
        const index = pair.indexOf(equals);
        const key = index >= 0 ? decode(pair.slice(0, index)) : decode(pair);
        const value = index >= 0 ? decode(pair.slice(index + 1)) : "";
        count++;
        if (result[key] === undefined) {
            result[key] = value;
        } else if (Array.isArray(result[key])) {
            result[key].push(value);
        } else {
            result[key] = [result[key], value];
        }
    }
    return result;
}

module.exports = {
    escape,
    unescape,
    encode: stringify,
    decode: parse,
    stringify,
    parse,
};
