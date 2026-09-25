"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { URL: SkyURL, URLSearchParams } = require("../../js/internal/url-core.js");
const { URL: NodeURL } = require("node:url");

test("URL parses and normalizes like node's WHATWG URL", () => {
    const cases = ["http://user:pw@example.com:8080/a/b?x=1&y=2#h",
        "https://example.com/", "https://example.com", "http://a.com:80/p",
        "https://a.com:443/p", "ftp://h/p", "ws://h/s"];
    for (const value of cases) {
        const mine = new SkyURL(value);
        const node = new NodeURL(value);
        assert.equal(mine.href, node.href, value);
        assert.equal(mine.host, node.host, value);
        assert.equal(mine.hostname, node.hostname, value);
        assert.equal(mine.pathname, node.pathname, value);
        assert.equal(mine.search, node.search, value);
        assert.equal(mine.hash, node.hash, value);
        assert.equal(mine.origin, node.origin, value);
    }
});

test("URL resolves relative references", () => {
    const base = "http://a/b/c/d;p?q";
    for (const relative of ["../g", "g", "./g", "/g", "?y", "#s", "",
        "./g/../h", "g?y#s"]) {
        assert.equal(new SkyURL(relative, base).href,
            new NodeURL(relative, base).href, JSON.stringify(relative));
    }
});

test("URLSearchParams stays in sync with the URL", () => {
    const url = new SkyURL("http://a/p?x=1");
    url.searchParams.set("y", "2");
    const node = new NodeURL("http://a/p?x=1");
    node.searchParams.set("y", "2");
    assert.equal(url.href, node.href);
    assert.equal(url.searchParams.get("y"), "2");

    const params = new URLSearchParams("a=1&b=2&b=3");
    assert.deepEqual(params.getAll("b"), ["2", "3"]);
    assert.equal(params.toString(), "a=1&b=2&b=3");
});
