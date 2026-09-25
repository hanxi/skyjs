"use strict";

// Engine self-verification contract: assertion helpers plus the result
// hand-off used by the node-compat differential runner.

const fs = require("../../internal/fs-core.js");

let failures = 0;
let checks = 0;

function ok(value, message) {
    checks++;
    if (!value) {
        failures++;
        throw new Error("assertion failed" + (message ? ": " + message : ""));
    }
    return value;
}

function equal(actual, expected, message) {
    checks++;
    if (actual !== expected) {
        failures++;
        throw new Error("expected " + JSON.stringify(expected) + ", got " +
            JSON.stringify(actual) + (message ? " (" + message + ")" : ""));
    }
    return actual;
}

function deepEqual(actual, expected, message) {
    checks++;
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures++;
        throw new Error("deep mismatch: expected " + b + ", got " + a +
            (message ? " (" + message + ")" : ""));
    }
    return actual;
}

function fail(message) {
    checks++;
    failures++;
    throw new Error(message || "explicit failure");
}

function writeResult(file, text) {
    fs.writeFile(file, text === undefined ? "" : String(text));
}

function summary() {
    return { checks, failures };
}

module.exports = {
    ok,
    equal,
    deepEqual,
    fail,
    writeResult,
    summary,
};
