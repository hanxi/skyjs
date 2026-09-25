"use strict";

// Node-compatible `url` facade: URLSearchParams re-export plus the legacy
// parse/format/resolve helpers built on the WHATWG URL implementation.

const urlSearchParams = require("../internal/url-search-params.js");
const querystring = require("./querystring.js");
const path = require("./path.js");

const URLSearchParams = urlSearchParams.URLSearchParams;

function toStr(value) {
    if (value instanceof URL) return value.toString();
    return String(value);
}

function parse(input, parseQueryString, slashesDenoteHost) {
    const text = String(input);
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text);
    if (!hasScheme) {
        const legacy = parseLoose(text, slashesDenoteHost);
        if (legacy === null) return null;
        return finishLegacy(legacy, parseQueryString);
    }

    let parsed;
    try {
        parsed = new URL(text);
    } catch (err) {
        return null;
    }

    const result = {
        protocol: parsed.protocol || null,
        slashes: text.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text),
        auth: parsed.username
            ? parsed.username + (parsed.password ? ":" + parsed.password : "")
            : null,
        host: parsed.host || null,
        port: parsed.port || null,
        hostname: parsed.hostname || null,
        hash: parsed.hash || null,
        search: parsed.search || null,
        query: parsed.search ? parsed.search.slice(1) : null,
        pathname: parsed.pathname || null,
        path: (parsed.pathname || "") + (parsed.search || ""),
        href: text,
    };
    if (parseQueryString) {
        result.query = result.query === null ? {} : querystring.parse(result.query);
    }
    return result;
}

function finishLegacy(legacy, parseQueryString) {
    const result = {
        protocol: legacy.protocol,
        slashes: legacy.slashes,
        auth: legacy.auth,
        host: legacy.host,
        port: legacy.port,
        hostname: legacy.hostname,
        hash: legacy.hash,
        search: legacy.search,
        query: legacy.query,
        pathname: legacy.pathname,
        path: legacy.path,
        href: legacy.href,
    };
    if (parseQueryString) {
        result.query = result.query === null || result.query === undefined ?
            {} : querystring.parse(result.query);
    }
    return result;
}

function parseLoose(input, slashesDenoteHost) {
    let rest = input;
    let protocol = null;
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(input);
    if (scheme !== null) {
        protocol = scheme[1].toLowerCase() + ":";
        rest = input.slice(scheme[0].length);
    }

    let host = null;
    let slashes = false;
    if (rest.startsWith("//") && (protocol !== null || slashesDenoteHost)) {
        slashes = true;
        rest = rest.slice(2);
        const slash = rest.indexOf("/");
        host = slash < 0 ? rest : rest.slice(0, slash);
        rest = slash < 0 ? "" : rest.slice(slash);
    } else if (protocol === null && slashesDenoteHost) {
        const slash = rest.indexOf("/");
        host = slash < 0 ? rest : rest.slice(0, slash);
        rest = slash < 0 ? "" : rest.slice(slash);
    }

    let hash = null;
    const hashIndex = rest.indexOf("#");
    if (hashIndex >= 0) {
        hash = rest.slice(hashIndex);
        rest = rest.slice(0, hashIndex);
    }
    let search = null;
    const searchIndex = rest.indexOf("?");
    if (searchIndex >= 0) {
        search = rest.slice(searchIndex);
        rest = rest.slice(0, searchIndex);
    }
    // Node's legacy parser reports pathname/path as null when the input has no
    // path component at all (empty string, or only a search/hash).
    const pathname = rest === "" ? null : rest;
    return {
        protocol,
        slashes: protocol === null && host === null ? null : (slashes || protocol !== null),
        auth: null,
        host: host || null,
        port: null,
        hostname: host || null,
        hash,
        search,
        query: search !== null ? search.slice(1) : null,
        pathname,
        path: pathname === null ? search : pathname + (search || ""),
        href: input,
    };
}

function format(input) {
    if (input instanceof URL) return input.toString();
    if (typeof input !== "object" || input === null) {
        throw new TypeError("Parameter 'url' must be an object");
    }
    const protocol = input.protocol || "";
    const slashes = input.slashes;
    const auth = input.auth ? input.auth + "@" : "";
    let host = "";
    if (input.host) {
        host = input.host;
    } else if (input.hostname) {
        host = input.hostname + (input.port ? ":" + input.port : "");
    }
    const pathname = input.pathname || "";
    const search = input.search || (input.query ? "?" +
        (typeof input.query === "string" ? input.query : querystring.stringify(input.query)) : "");
    const hash = input.hash || "";
    let out = protocol;
    if (host !== "") out += "//";
    out += auth + host + pathname + search + hash;
    out = out.replace(/([^:]\/)\/+/g, "$1");
    return out;
}

function resolve(from, to) {
    return String(new URL(to, new URL(from, "resolve://")).href)
        .replace(/^resolve:\/\//, "");
}

function urlToHttpOptions(url) {
    const options = {
        protocol: url.protocol,
        hostname: url.hostname,
        hash: url.hash,
        search: url.search,
        pathname: url.pathname,
        path: url.pathname + url.search,
        href: url.href,
    };
    if (url.port !== "") options.port = Number(url.port);
    if (url.username || url.password) {
        options.auth = decodeURIComponent(url.username) + ":" +
            decodeURIComponent(url.password);
    }
    return options;
}

function fileURLToPath(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") {
        throw new TypeError("The URL must be of scheme file");
    }
    return decodeURIComponent(parsed.pathname);
}

function pathToFileURL(filepath) {
    return new URL("file://" + encodeURI(path.resolve(String(filepath))));
}

module.exports = {
    URL,
    URLSearchParams,
    parse,
    format,
    resolve,
    urlToHttpOptions,
    fileURLToPath,
    pathToFileURL,
    domainToASCII: (domain) => String(domain),
    domainToUnicode: (domain) => String(domain),
};
