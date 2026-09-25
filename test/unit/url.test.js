"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const url = require("../../js/builtins/url.js");

test("url.parse mirrors node:url legacy shapes", () => {
    const cases = ["http://user:pw@example.com:8080/a/b?x=1&y=2#h",
        "https://example.com/", "/a/b?c=d", "ftp://h/p", "//host/p", "a/b",
        "?x=1", "", "#h"];
    for (const value of cases) {
        assert.deepEqual({ ...url.parse(value) }, { ...{
            protocol: null, slashes: null, auth: null, host: null, port: null,
            hostname: null, hash: null, search: null, query: null,
            pathname: null, path: null, href: value,
        }, ...url.parse(value) });
    }
});

test("url.format/resolve/urlToHttpOptions behave", () => {
    assert.equal(
        url.format({ protocol: "https:", host: "a.com", pathname: "/p" }),
        "https://a.com/p");
    assert.equal(url.resolve("http://a/b/c", "../d"), "http://a/d");
    const options = url.urlToHttpOptions(new url.URL("http://u:p@a.com:81/x?y=1#z"));
    assert.equal(options.port, 81);
    assert.equal(options.auth, "u:p");
    assert.equal(options.path, "/x?y=1");
});

test("URLSearchParams round-trips", () => {
    const params = new url.URLSearchParams("a=1&b=2&b=3");
    assert.equal(params.get("a"), "1");
    assert.deepEqual(params.getAll("b"), ["2", "3"]);
    params.set("a", "9");
    params.append("c", "x y");
    assert.equal(params.toString(), "a=9&b=2&b=3&c=x+y");
    assert.equal(params.has("c"), true);
    assert.equal(new url.URLSearchParams({ a: "1" }).get("a"), "1");
});
