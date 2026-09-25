"use strict";

// Client for the `.subprocess` owner plus the Node-shaped ChildProcess object.
// Both `require('child_process')` and `require('skyjs/subprocess')` sit on this.

const frame = require("./binary-frame.js");
const stream = require("../builtins/stream/index.js");
const skynetCore = require("./skynet-core.js");
const errors = require("./errors.js");

let ownerHandle = 0;
let nextRequestId = 1;

function owner() {
    if (ownerHandle === 0) {
        ownerHandle = skynetCore.newservice("snjs service/subprocess-service.js");
    }
    return ownerHandle;
}

async function call(header, body) {
    const svc = owner();
    const reqId = nextRequestId++;
    const request = frame.frameEncode(Object.assign({ reqId }, header), body);
    const reply = await skynetCore.call(svc, "lua", request);
    const { header: replyHeader, body: replyBody } = frame.frameDecode(reply);
    if (replyHeader.ok !== true) {
        const err = new Error(replyHeader.message || "subprocess owner error");
        err.code = replyHeader.code || "ERR_IO";
        err.detail = {
            skyjsCode: replyHeader.code || "ERR_IO",
            exitCode: replyHeader.exitCode,
            signal: replyHeader.signal,
        };
        throw err;
    }
    return { header: replyHeader, body: replyBody };
}

class ChildProcess extends stream.EventEmitter {
    constructor(pid, opts) {
        super();
        this.pid = pid;
        this.exitCode = null;
        this.signalCode = null;
        this.killed = false;
        this._opts = opts || {};
        this._pidPromise = pid > 0 ? Promise.resolve(pid) : null;
        this.stdout = new stream.Readable({ read() {} });
        this.stderr = new stream.Readable({ read() {} });
        this.stdin = new stream.Writable({
            write: (chunk, encoding, callback) => {
                this._pid().then(
                    (pidValue) => call({ op: "write", pid: pidValue },
                        toArrayBuffer(chunk)),
                    (err) => { throw err; }).then(
                    () => callback(), (err) => callback(err));
            },
            final: (callback) => {
                this._pid().then(
                    (pidValue) => call({ op: "closeStdin", pid: pidValue }),
                    () => {}).then(() => callback(), () => callback());
            },
        });
    }

    /** Bind the real pid once the owner acknowledges (deferred-spawn case). */
    _bind(pidValue) {
        this.pid = pidValue;
        this._pidPromise = Promise.resolve(pidValue);
    }

    _pid() {
        return this._pidPromise || Promise.resolve(this.pid);
    }

    async wait() {
        const pid = await this._pid();
        return this._waitFor(pid);
    }

    async _waitFor(pid) {
        for (;;) {
            const { header } = await call({ op: "status", pid });
            if (header.exited) {
                const stdout = await call({ op: "read", pid, stream: "stdout" });
                const stderr = await call({ op: "read", pid, stream: "stderr" });
                this.exitCode = header.code;
                this.signalCode = header.signal || null;
                if (stdout.body) this.stdout.push(new Uint8Array(stdout.body));
                if (stderr.body) this.stderr.push(new Uint8Array(stderr.body));
                this.stdout.push(null);
                this.stderr.push(null);
                this.emit("exit", this.exitCode, this.signalCode);
                this.emit("close", this.exitCode, this.signalCode);
                await call({ op: "release", pid });
                return { code: this.exitCode, signal: this.signalCode };
            }
            await skynetCore.sleep(20);
        }
    }

    kill(signal) {
        this.killed = true;
        this._pid().then((pid) => call({ op: "kill", pid, signal }), () => {});
        return true;
    }
}

function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) return chunk;
    if (ArrayBuffer.isView(chunk)) {
        return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    }
    return new TextEncoder().encode(String(chunk)).buffer;
}

/**
 * Start a process. Returns a ChildProcess synchronously; the owner round-trip
 * that yields the real pid resolves in the background (await child.ready).
 */
function spawn(program, args, options) {
    const opts = options || {};
    const child = new ChildProcess(0, opts);
    const request = call({
        op: "spawn",
        program,
        args: args || [],
        opts: {
            cwd: opts.cwd,
            env: opts.env ? Object.entries(opts.env).map(([k, v]) => k + "=" + v) : undefined,
            stdin: opts.stdin || "pipe",
            stdout: opts.stdout || "pipe",
            stderr: opts.stderr || "pipe",
        },
        maxOutput: opts.maxOutput,
    }).then(({ header }) => {
        child._bind(header.pid);
        child.emit("spawn");
        return child;
    }, (err) => {
        child.ready = Promise.reject(err);
        child.ready.catch(() => {});
        child.emit("error", err);
        throw err;
    });
    child.ready = request;
    request.catch(() => {});
    return child;
}

async function exec(program, args, options) {
    const opts = options || {};
    const child = await spawn(program, args, opts);
    if (opts.stdin !== undefined && opts.stdin !== null) {
        child.stdin.end(toArrayBuffer(opts.stdin));
    } else {
        child.stdin.end();
    }
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    const status = await child.wait();
    const stdoutBytes = Buffer.concat(chunks);
    if (status.code !== 0 && opts.allowNonZero !== true) {
        const err = errors.skyjsError("ERR_IO",
            program + " exited with code " + status.code, { exitCode: status.code });
        err.exitCode = status.code;
        err.signal = status.signal;
        err.stdout = stdoutBytes;
        throw err;
    }
    return {
        code: status.code,
        signal: status.signal,
        stdout: opts.encoding === "binary" ? stdoutBytes : stdoutBytes.toString("utf8"),
        stderr: "",
    };
}

module.exports = {
    spawn,
    exec,
    ChildProcess,
    call,
    owner,
};
