"use strict";

module.exports.run = function () {
    const url = require("url");
    const cases = ["http://user:pw@example.com:8080/a/b?x=1&y=2#h",
        "https://example.com/", "/a/b?c=d", "ftp://h/p", "//host/p", "a/b",
        "?x=1", "", "#h", "/p"];
    const parsed = cases.map((c) => [c, url.parse(c), url.parse(c, true)]);
    const formats = [
        { protocol: "https:", host: "a.com", pathname: "/p" },
        { protocol: "http:", slashes: true, host: "a.com", pathname: "/p", search: "?x=1" },
        { protocol: "https:", hostname: "a.com", slashes: false },
    ].map((f) => [f, url.format(f)]);
    const params = new url.URLSearchParams("a=1&b=2&b=3");
    params.set("a", "9");
    params.append("c", "x y");
    return {
        parse: parsed,
        format: formats,
        resolve: url.resolve("http://a/b/c", "../d"),
        searchParams: params.toString(),
        getAll: params.getAll("b"),
        has: [params.has("a"), params.has("zz")],
        sep: url.URLSearchParams.name,
    };
};
