"use strict";

module.exports.run = function () {
    const qs = require("querystring");
    const samples = ["", "a=1&b=2", "a=1&a=2", "a", "a=", "=b", "a=b=c",
        "x=%20%21", "a%5Bb%5D=1", "a=%E4%B8%AD"];
    const objects = [{ a: 1, b: "x" }, { a: ["1", "2"], b: "" },
        { a: undefined, b: 2 }, { "k k": "v v" }, { "!": "~" },
        { a: null }, { a: 0 }, { a: false }];
    const escChars = " !'()~*abc/?#[]@$&+;=:%^`|{}<>\"\\";
    return {
        parse: samples.map((s) => [s, qs.parse(s)]),
        stringify: objects.map((o) => [o, qs.stringify(o)]),
        escape: escChars.split("").map((c) => [c, qs.escape(c)]),
        unescape: ["%20", "%21", "a+b", "%E4%B8%AD"].map((s) => [s, qs.unescape(s)]),
    };
};
