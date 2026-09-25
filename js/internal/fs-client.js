"use strict";

// Client for the `.fs` owner service. Keeps an Actor-local handle to the owner
// and speaks binary-frame envelopes, so large reads/writes never go through
// base64.

const frame = require("./binary-frame.js");
const skynetCore = require("./skynet-core.js");
const pathPosix = require("./path-posix.js");

let ownerHandle = 0;
let nextRequestId = 1;

function owner() {
    if (ownerHandle === 0) {
        ownerHandle = skynetCore.newservice("snjs service/fs-service.js");
    }
    return ownerHandle;
}

async function call(header, body) {
    const svc = owner();
    const reqId = nextRequestId++;
    // The owner runs in its own Actor with its own cwd; resolve relative paths
    // against the caller's cwd so both sides agree on the target.
    const request = Object.assign({ reqId }, header);
    if (typeof request.path === "string") {
        request.path = pathPosix.resolve(request.base || pathPosix.resolve("."),
            request.path);
        delete request.base;
    }
    const encoded = frame.frameEncode(request, body);
    const reply = await skynetCore.call(svc, "lua", encoded);
    const { header: replyHeader, body: replyBody } = frame.frameDecode(reply);
    if (replyHeader.ok !== true) {
        const err = new Error(replyHeader.message || "fs owner error");
        err.code = replyHeader.code || "ERR_IO";
        err.errno = replyHeader.errno;
        err.syscall = replyHeader.syscall;
        err.path = replyHeader.path;
        err.detail = { skyjsCode: replyHeader.skyjsCode || "ERR_IO" };
        throw err;
    }
    return { header: replyHeader, body: replyBody };
}

async function readFile(path, base) {
    const { body } = await call({ op: "readFile", path, base });
    return body === null ? new ArrayBuffer(0) : body;
}

async function writeFile(path, data, base) {
    await call({ op: "writeFile", path, base }, data);
}

async function stat(path, base) {
    const { body } = await call({ op: "stat", path, base });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body)));
}

async function readdir(path, base) {
    const { body } = await call({ op: "readdir", path, base });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body)));
}

async function configure(options) {
    await call(Object.assign({ op: "policy" }, options));
}

async function ping() {
    const { header } = await call({ op: "ping" });
    return header;
}

module.exports = { readFile, writeFile, stat, readdir, configure, ping, call };
