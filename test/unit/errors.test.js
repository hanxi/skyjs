"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const errors = require("../../js/internal/errors.js");

test("systemError exposes Node fields plus skyjs classification", () => {
    const err = errors.systemError("ENOENT", "open", "/tmp/missing");
    assert.equal(err.code, "ENOENT");
    assert.equal(err.errno, -2);
    assert.equal(err.syscall, "open");
    assert.equal(err.path, "/tmp/missing");
    assert.equal(err.detail.skyjsCode, "ERR_NOT_FOUND");
    assert.ok(err instanceof Error);
});

test("SkyJS-native errors keep ERR_* in code and detail", () => {
    const err = errors.skyjsError("ERR_PERMISSION", "denied", { path: "/x" });
    assert.equal(err.code, "ERR_PERMISSION");
    assert.equal(err.detail.skyjsCode, "ERR_PERMISSION");
    assert.equal(err.detail.path, "/x");
});

test("normalizeError maps C message text to a Node code", () => {
    const mapped = errors.normalizeError(
        new Error("io.read_file: can't open /a"), { path: "/a" });
    assert.equal(mapped.code, "ENOENT");
    assert.equal(mapped.path, "/a");

    const passthrough = errors.systemError("EACCES", "open", "/b");
    assert.equal(errors.normalizeError(passthrough), passthrough);

    const fallback = errors.normalizeError("plain string");
    assert.equal(fallback.code, "ERR_INTERNAL");
});

test("abort and timeout helpers keep Node error names", () => {
    const aborted = errors.abortedError();
    assert.equal(aborted.name, "AbortError");
    assert.equal(aborted.code, "ABORT_ERR");
    assert.equal(aborted.detail.skyjsCode, "ERR_CANCELLED");

    const timedOut = errors.timeoutError(25);
    assert.equal(timedOut.name, "TimeoutError");
    assert.equal(timedOut.code, "ERR_TIMEOUT");
    assert.equal(timedOut.detail.timeoutMs, 25);
});

test("errno table matches Node's negative err.errno values", () => {
    // Node exposes positive values in os.constants.errno but negative values
    // on err.errno; SkyJS follows the err.errno convention.
    const nodeErrno = require("node:os").constants.errno;
    assert.equal(errors.ERRNO.EACCES, -nodeErrno.EACCES);
    assert.equal(errors.ERRNO.EEXIST, -nodeErrno.EEXIST);
    assert.equal(errors.ERRNO.EISDIR, -nodeErrno.EISDIR);
    assert.equal(errors.ERRNO.ENOENT, -nodeErrno.ENOENT);
});
