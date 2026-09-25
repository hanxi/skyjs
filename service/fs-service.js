"use strict";

// `.fs` owner service: the single actor that performs blocking filesystem work
// on behalf of other services. Requests arrive as internal/binary-frame
// envelopes (no base64), responses carry the same framing. Concurrent calls are
// serialized by the actor model; each op enforces the permission set.

const frame = require("../js/internal/binary-frame.js");
const fsx = require("../js/internal/fs-core.js");
const permission = require("../js/internal/permission.js");
const errors = require("../js/internal/errors.js");

let policy = permission.defaultPermission();
let inFlight = 0;
let totalOps = 0;

function ok(header, body) {
    return frame.frameEncode(Object.assign({ ok: true }, header),
        body === undefined ? null : body);
}

function fail(reqId, op, err) {
    const mapped = errors.normalizeError(err, { path: err && err.path });
    return frame.frameEncode({
        ok: false,
        reqId,
        op,
        code: mapped.code,
        errno: mapped.errno,
        syscall: mapped.syscall,
        path: mapped.path,
        skyjsCode: mapped.detail ? mapped.detail.skyjsCode : undefined,
        message: mapped.message,
    });
}

function handle(header) {
    const op = header.op;
    const reqId = header.reqId;
    switch (op) {
    case "ping":
        return ok({ reqId, op: "pong", inFlight, totalOps });

    case "policy": {
        // Actor-local policy update (root boundary / quota / read-only).
        policy = new permission.Permission({
            roots: header.roots || [],
            maxReadBytes: header.maxReadBytes,
            readOnly: header.readOnly,
        });
        return ok({ reqId, op });
    }

    case "readFile": {
        const target = policy.resolvePath(header.path, header.base);
        const st = fsx.stat(target);
        policy.checkQuota(st ? st.size : 0, "readFile");
        const ab = fsx.readFile(target);
        return ok({ reqId, op, size: ab.byteLength }, ab);
    }

    case "writeFile": {
        const target = policy.resolvePath(header.path, header.base);
        policy.checkWrite("writeFile", target);
        return ok({ reqId, op });
    }

    case "stat": {
        const target = policy.resolvePath(header.path, header.base);
        const st = fsx.stat(target);
        return frame.frameEncode({ ok: true, reqId, op },
            new TextEncoder().encode(JSON.stringify(st)).buffer);
    }

    case "readdir": {
        const target = policy.resolvePath(header.path, header.base);
        const names = fsx.readdir(target);
        return frame.frameEncode({ ok: true, reqId, op },
            new TextEncoder().encode(JSON.stringify(names)).buffer);
    }

    case "json": {
        // Small structured responses ride in the header (no body).
        const target = policy.resolvePath(header.path, header.base);
        const st = fsx.stat(target);
        return frame.frameEncode({ ok: true, reqId, op, stat: st });
    }

    default:
        return frame.frameEncode({
            ok: false, reqId, op, code: "ERR_PROTOCOL",
            message: "unknown fs op: " + op,
        });
    }
}

function decodeRequest(buffer) {
    const { header, body } = frame.frameDecode(buffer);
    return { header, body };
}

skynet.start(() => {
    skynet.dispatch("lua", (msg) => {
        inFlight++;
        totalOps++;
        try {
            const { header, body } = decodeRequest(msg);
            // writeFile carries its payload in body; apply it here.
            if (header.op === "writeFile") {
                const target = policy.resolvePath(header.path, header.base);
                policy.checkWrite("writeFile", target);
                const payload = body === null ? new ArrayBuffer(0) : body;
                policy.checkQuota(payload.byteLength, "writeFile");
                fsx.writeFile(target, payload);
                inFlight--;
                return ok({ reqId: header.reqId, op: "writeFile", size: payload.byteLength });
            }
            const reply = handle(header);
            inFlight--;
            return reply;
        } catch (err) {
            inFlight--;
            return fail(undefined, undefined, err);
        }
    });
});
