// skyjs async IO service (Phase C).
// A dedicated skynet service that executes synchronous fs calls on behalf
// of callers, turning blocking file I/O into non-blocking skynet.call RPCs.
//
// Protocol: PTYPE_LUA (seri pack/unpack).
//   Request:  skynet.pack(op, arg1, arg2, ...)
//   Response: skynet.pack(true, result)   -- success
//             skynet.pack(false, errmsg)  -- failure
//
// Binary data (read_file result, write_file/append_file input) is transported
// as base64 strings because js-seri does not support ArrayBuffer round-trip.
// stat() returns a JSON string; readdir() returns a JSON string (array).
"use strict";

const crypt = require("./internal/crypt-core.js");
const io = require("./internal/fs-core.js");

skynet.start(() => {
    skynet.dispatch("lua", (msg) => {
        const args = skynet.unpack(msg);
        const op = args[0];
        try {
            switch (op) {
            case "read_file": {
                const ab = io.readFile(args[1]);
                return skynet.pack(true, crypt.base64Encode(ab));
            }
            case "read_text_file": {
                const text = io.readTextFile(args[1]);
                return skynet.pack(true, text);
            }
            case "write_file": {
                const ab = crypt.base64Decode(args[2]);
                io.writeFile(args[1], ab);
                return skynet.pack(true);
            }
            case "append_file": {
                const ab = crypt.base64Decode(args[2]);
                io.appendFile(args[1], ab);
                return skynet.pack(true);
            }
            case "stat": {
                const st = io.stat(args[1]);
                return skynet.pack(true, st === null ? null : JSON.stringify(st));
            }
            case "readdir": {
                const entries = io.readdir(args[1]);
                return skynet.pack(true, JSON.stringify(entries));
            }
            case "mkdir": {
                io.mkdir(args[1], !!args[2]);
                return skynet.pack(true);
            }
            case "remove": {
                io.remove(args[1]);
                return skynet.pack(true);
            }
            case "rename": {
                io.rename(args[1], args[2]);
                return skynet.pack(true);
            }
            default:
                return skynet.pack(false, "ioservice: unknown op " + op);
            }
        } catch (e) {
            return skynet.pack(false, String(e && e.message ? e.message : e));
        }
    });
});
