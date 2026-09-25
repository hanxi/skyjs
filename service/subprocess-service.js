"use strict";

// `.subprocess` owner service: the single actor that owns child-process
// handles. It runs the stdio read loops and enforces per-caller quotas. RPC
// uses internal/binary-frame envelopes.

const frame = require("../js/internal/binary-frame.js");
const sub = skynetcore.subprocess;
const errors = require("../js/internal/errors.js");

const MAX_PROCESSES = 16;
const procs = new Map();   // pid -> record

function ok(header, body) {
    return frame.frameEncode(Object.assign({ ok: true }, header),
        body === undefined ? null : body);
}

function fail(reqId, op, err) {
    const mapped = errors.normalizeError(err);
    return frame.frameEncode({
        ok: false, reqId, op,
        code: mapped.code,
        message: mapped.message,
        exitCode: err && err.exitCode,
        signal: err && err.signal,
    });
}

function spawn(header, body) {
    if (procs.size >= MAX_PROCESSES) {
        throw errors.skyjsError("ERR_LIMIT_EXCEEDED",
            "process quota reached (" + MAX_PROCESSES + ")");
    }
    const started = sub.spawn(header.program, header.args || [], header.opts || {});
    const record = {
        pid: started.pid,
        stdinFd: started.stdinFd,
        stdoutFd: started.stdoutFd,
        stderrFd: started.stderrFd,
        exited: false,
        code: 0,
        signal: 0,
        stdout: [],
        stderr: [],
        maxOutput: header.maxOutput || 10 * 1024 * 1024,
        truncated: false,
    };
    procs.set(record.pid, record);
    pump(record);
    return ok({ reqId: header.reqId, op: "spawn", pid: record.pid });
}

/** Poll stdout/stderr into the record until EOF, then waitpid. */
function pump(record) {
    const tick = () => {
        if (record.exited) return;
        drain(record, record.stdoutFd, record.stdout);
        drain(record, record.stderrFd, record.stderr);
        const status = sub.wait(record.pid);
        if (status.exited) {
            // one last drain after exit so no bytes are lost
            drain(record, record.stdoutFd, record.stdout);
            drain(record, record.stderrFd, record.stderr);
            record.exited = true;
            record.code = status.code;
            record.signal = status.signal;
            return;
        }
        skynet.timeout(1, tick);
    };
    skynet.timeout(1, tick);
}

function drain(record, fd, sink) {
    if (fd < 0) return;
    for (;;) {
        const chunk = sub.read(fd, 65536);
        if (chunk === "again") return;
        if (chunk === "eof") {
            sub.close(fd);
            if (fd === record.stdoutFd) record.stdoutFd = -1;
            if (fd === record.stderrFd) record.stderrFd = -1;
            return;
        }
        if (record.truncated) continue;
        const bytes = new Uint8Array(chunk);
        sink.push(bytes);
        const total = sink.reduce((n, b) => n + b.length, 0);
        if (total > record.maxOutput) {
            record.truncated = true;
            sink.length = 0;
        }
    }
}

function concat(list) {
    let total = 0;
    for (const b of list) total += b.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of list) { out.set(b, off); off += b.length; }
    return out.buffer;
}

function handle(header, body) {
    const op = header.op;
    const reqId = header.reqId;
    switch (op) {
    case "ping":
        return ok({ reqId, op: "pong", count: procs.size });
    case "spawn":
        return spawn(header, body);
    case "status": {
        const record = procs.get(header.pid);
        if (!record) return fail(reqId, op, errors.skyjsError("ERR_NOT_FOUND", "unknown pid"));
        return ok({
            reqId, op, pid: record.pid, exited: record.exited,
            code: record.code, signal: record.signal,
            truncated: record.truncated,
            stdoutLength: concat(record.stdout).byteLength,
            stderrLength: concat(record.stderr).byteLength,
        });
    }
    case "read": {
        const record = procs.get(header.pid);
        if (!record) return fail(reqId, op, errors.skyjsError("ERR_NOT_FOUND", "unknown pid"));
        if (!record.exited) {
            return ok({ reqId, op, pid: record.pid, pending: true });
        }
        const which = header.stream === "stderr" ? record.stderr : record.stdout;
        return ok({ reqId, op, pid: record.pid, exited: true }, concat(which));
    }
    case "write": {
        const record = procs.get(header.pid);
        if (!record) return fail(reqId, op, errors.skyjsError("ERR_NOT_FOUND", "unknown pid"));
        if (record.stdinFd < 0) return fail(reqId, op, errors.skyjsError("ERR_IO", "stdin closed"));
        const payload = body === null ? new ArrayBuffer(0) : body;
        const n = sub.write(record.stdinFd, payload);
        return ok({ reqId, op, written: n });
    }
    case "closeStdin": {
        const record = procs.get(header.pid);
        if (!record) return fail(reqId, op, errors.skyjsError("ERR_NOT_FOUND", "unknown pid"));
        if (record.stdinFd >= 0) {
            sub.close(record.stdinFd);
            record.stdinFd = -1;
        }
        return ok({ reqId, op });
    }
    case "kill": {
        const record = procs.get(header.pid);
        if (!record) return fail(reqId, op, errors.skyjsError("ERR_NOT_FOUND", "unknown pid"));
        sub.kill(record.pid, header.signal === undefined ? 15 : header.signal);
        return ok({ reqId, op });
    }
    case "release": {
        const record = procs.get(header.pid);
        if (!record) return ok({ reqId, op });
        sub.release(record.pid);
        procs.delete(record.pid);
        return ok({ reqId, op });
    }
    case "list":
        return ok({ reqId, op, pids: Array.from(procs.keys()) });
    default:
        return frame.frameEncode({
            ok: false, reqId, op, code: "ERR_PROTOCOL",
            message: "unknown subprocess op: " + op,
        });
    }
}

skynet.start(() => {
    skynet.dispatch("lua", (msg) => {
        try {
            const { header, body } = frame.frameDecode(msg);
            return handle(header, body);
        } catch (err) {
            return fail(undefined, undefined, err);
        }
    });
});
