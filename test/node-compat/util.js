"use strict";

module.exports.run = function () {
    const util = require("util");
    const formatCases = [
        ["%s-%d", "a", 3], ["%j", { a: 1 }], ["%%"], ["no fmt", 1, 2],
        ["%i", "12px"], ["%f", "1.5x"], ["extra", "a", "b"], ["hi", "a"],
        ["%s", "a", "b"], ["%d", "x"], [1, "a"], ["%o", [1, 2]],
        ["%s", null], ["%d", true],
    ];
    return {
        format: formatCases.map(([f, ...a]) => [f, a, util.format(f, ...a)]),
        isDeepStrictEqual: [
            [util.isDeepStrictEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })],
            [util.isDeepStrictEqual({ a: 1 }, { a: 2 })],
            [util.isDeepStrictEqual([1, 2], [1, 2])],
            [util.isDeepStrictEqual(new Date(0), new Date(0))],
            [util.isDeepStrictEqual({ a: undefined }, {})],
        ],
        types: {
            isDate: [util.types.isDate(new Date()), util.types.isDate(1)],
            isTypedArray: [util.types.isTypedArray(new Uint8Array(1)),
                util.types.isTypedArray([])],
            isPromise: [util.types.isPromise(Promise.resolve()),
                util.types.isPromise({})],
            isNativeError: [util.types.isNativeError(new Error("x")),
                util.types.isNativeError("x")],
            isAnyArrayBuffer: [util.types.isAnyArrayBuffer(new ArrayBuffer(1)),
                util.types.isAnyArrayBuffer({})],
        },
        getSystemErrorName: [-2, -13, -17].map((n) => util.getSystemErrorName(n)),
    };
};
