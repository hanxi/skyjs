// skyjs async service core (Task 3).
// Loaded by snjs before the user script (env key "jsLoader", default "./js/skynet.js").
// The C layer then calls globalThis.dispatch (wrapped by __snjs_wrap) with
// (msg, session, source, type).
//
// Scheduling model (isomorphic to lualib/skynet.lua):
//   skynet.lua                     skynet.js
//   session <-> coroutine map      session <-> {resolve, reject} in pending_calls
//   coroutine.yield()              await (dispatch returns a Promise)
//   wakeup via resume              resolve() on the matching response message
// Every await waits on an external event (response/timer), so the pending-job
// queue always drains before the C dispatch returns the worker thread.
//
// Structure note: like socket.js/skyjs cluster.js, everything lives in an IIFE; only
// globalThis.skynet and the __snjs_* C-layer contracts are global.

// TextEncoder/TextDecoder polyfill. The QuickJS-ng runtime used by snjs does
// not ship the WHATWG Encoding API, yet crypt-core.js/net-helper-core.js/http-core.js/
// websocket-core.js all rely on UTF-8 <-> string conversion. skynet.js is the first
// runtime library loaded, so defining these here makes them available to every
// later module. Guarded so a future native implementation wins.
(function () {
    "use strict";

    if (typeof globalThis.TextEncoder === "undefined") {
        globalThis.TextEncoder = class TextEncoder {
            get encoding() { return "utf-8"; }
            encode(str) {
                str = str === undefined ? "" : String(str);
                const out = [];
                for (let i = 0; i < str.length; i++) {
                    let cp = str.charCodeAt(i);
                    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
                        const lo = str.charCodeAt(i + 1);
                        if (lo >= 0xdc00 && lo <= 0xdfff) {
                            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                            i++;
                        }
                    }
                    if (cp < 0x80) {
                        out.push(cp);
                    } else if (cp < 0x800) {
                        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
                    } else if (cp < 0x10000) {
                        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f),
                            0x80 | (cp & 0x3f));
                    } else {
                        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                    }
                }
                return new Uint8Array(out);
            }
        };
    }

    if (typeof globalThis.TextDecoder === "undefined") {
        globalThis.TextDecoder = class TextDecoder {
            constructor(label) {
                this._encoding = (label || "utf-8").toLowerCase();
            }
            get encoding() { return "utf-8"; }
            decode(input) {
                if (input === undefined) return "";
                let bytes;
                if (input instanceof Uint8Array) {
                    bytes = input;
                } else if (input instanceof ArrayBuffer) {
                    bytes = new Uint8Array(input);
                } else if (ArrayBuffer.isView(input)) {
                    bytes = new Uint8Array(input.buffer, input.byteOffset,
                        input.byteLength);
                } else {
                    throw new TypeError("TextDecoder.decode: expected BufferSource");
                }
                let out = "";
                let i = 0;
                const n = bytes.length;
                while (i < n) {
                    const b0 = bytes[i++];
                    let cp;
                    if (b0 < 0x80) {
                        cp = b0;
                    } else if ((b0 & 0xe0) === 0xc0) {
                        if (i < n && (bytes[i] & 0xc0) === 0x80) {
                            cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
                        } else {
                            cp = 0xfffd;
                        }
                    } else if ((b0 & 0xf0) === 0xe0) {
                        if (i + 1 < n && (bytes[i] & 0xc0) === 0x80 &&
                            (bytes[i + 1] & 0xc0) === 0x80) {
                            cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) |
                                (bytes[i++] & 0x3f);
                        } else {
                            cp = 0xfffd;
                        }
                    } else if ((b0 & 0xf8) === 0xf0) {
                        if (i + 2 < n && (bytes[i] & 0xc0) === 0x80 &&
                            (bytes[i + 1] & 0xc0) === 0x80 &&
                            (bytes[i + 2] & 0xc0) === 0x80) {
                            cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
                                ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
                        } else {
                            cp = 0xfffd;
                        }
                    } else {
                        cp = 0xfffd;
                    }
                    if (cp > 0xffff) {
                        cp -= 0x10000;
                        out += String.fromCharCode(0xd800 + (cp >> 10),
                            0xdc00 + (cp & 0x3ff));
                    } else {
                        out += String.fromCharCode(cp);
                    }
                }
                return out;
            }
        };
    }
})();

(function () {
    "use strict";

    const PTYPE_TEXT = 0;
    const PTYPE_RESPONSE = 1;
    const PTYPE_CLIENT = 3;
    const PTYPE_ERROR = 7;
    const PTYPE_LUA = 10;
    const PTYPE_SOCKET = 6;

    const proto = {};                 // id -> { name, id, dispatch }
    const pendingCalls = new Map();   // session -> { resolve, reject }
    const pendingTimers = new Map();  // session -> fn
    let socketHandler = null;
    let clusterRespHandler = null;
    let clusterErrHandler = null;

    function registerProtocol(p) {
        if (typeof p.id !== "number" || p.id < 0 || p.id > 255) throw new Error("invalid protocol id");
        proto[p.id] = p;
    }

    registerProtocol({ name: "text", id: PTYPE_TEXT });
    registerProtocol({ name: "lua", id: PTYPE_LUA });
    registerProtocol({ name: "client", id: PTYPE_CLIENT });

    function findType(typename) {
        for (const k in proto) {
            if (proto[k].name === typename) return proto[k].id;
        }
        throw new Error("Unknown protocol " + typename);
    }

    function skynetDispatch(typename, fn) {
        const id = findType(typename);
        proto[id].dispatch = fn;
    }

    function skynetCall(addr, typename, msg) {
        const type = findType(typename);
        const session = skynetcore.genId();
        // responses cross as raw bytes (binary-safe); text protocols decode here
        const isBinary = (type === PTYPE_LUA);
        return new Promise((resolve, reject) => {
            pendingCalls.set(session, {
                resolve: v => resolve(isBinary ? v : (v instanceof ArrayBuffer ? skynetcore.str(v) : v)),
                reject,
            });
            // ArrayBuffer payloads (skynet.pack) cross untouched; everything else
            // is coerced to its string form
            const payload = (msg === undefined || msg === null) ? "" : msg;
            const r = skynetcore.send(addr, type, payload, session);
            if (r < 0) {
                pendingCalls.delete(session);
                reject(new Error("skynet.call: send to " + addr + " failed"));
            }
        });
    }

    // fire-and-forget send (no session). lua payloads pack args to a seri
    // stream (binary-safe); text sends a single string argument.
    function skynetSend(addr, typename, ...args) {
        const type = findType(typename);
        const payload = (type === PTYPE_LUA)
            ? skynetcore.pack(...args)
            : (args.length === 0 || args[0] === undefined || args[0] === null ? "" : args[0]);
        return skynetcore.send(addr, type, payload, 0);
    }

    // redirect: forward a message with a spoofed source (skynet.redirect).
    // msg crosses untouched (string or ArrayBuffer, e.g. a raw client frame).
    function skynetRedirect(dest, source, typename, session, msg) {
        const type = findType(typename);
        return skynetcore.redirect(dest, source, type, session | 0,
            (msg === undefined || msg === null) ? "" : msg);
    }

    function skynetTimeout(ti, fn) {
        // ti is in centiseconds (10ms units), same as skynet.lua
        const s = skynetcore.intCommand("TIMEOUT", String(ti));
        pendingTimers.set(s, fn);
        return s;
    }

    function skynetSleep(ms) {
        return new Promise(resolve => skynetTimeout(Math.max(1, Math.round(ms / 10)), resolve));
    }

    function skynetFork(fn) {
        return Promise.resolve().then(fn).catch((e) => {
            skynetcore.error("fork error: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
        });
    }

    function skynetNewservice(name, param) {
        return skynetcore.intCommand("LAUNCH", param ? (name + " " + param) : name);
    }

    function skynetSelf() {
        const r = skynetcore.command("REG");   // ":hex"
        return r ? parseInt(r.slice(1), 16) : 0;
    }

    function skynetRegister(name) {
        const self = skynetcore.command("REG");
        skynetcore.command("NAME", "." + name + " " + self);
    }

    // socket events come pre-parsed as {type, id, ud, data} objects (snjs.c);
    // internal/net-core.js installs the actual handler via __snjs_set_socket_handler.
    globalThis.__snjs_set_socket_handler = function (fn) { socketHandler = fn; };
    // builtins/skyjs/cluster.js installs handlers for responses that don't belong to skynet.call
    // (cluster.call bookkeeping): (session, payload) and (session, source)
    globalThis.__snjs_set_cluster_handlers = function (resp, err) {
        clusterRespHandler = resp;
        clusterErrHandler = err;
    };

    // internal router: the C layer calls this (through __snjs_wrap) for every message
    function internalDispatch(msg, session, source, type) {
        if (type === PTYPE_SOCKET) {
            if (socketHandler) socketHandler(msg);
            return;
        }
        if (type === PTYPE_RESPONSE) {
            // routing order: skynet.call sessions, then timer sessions, and only
            // as a last resort the cluster bridge (its handler ignores unknown
            // sessions, so putting it first would swallow TIMEOUT replies)
            const p = pendingCalls.get(session);
            if (p) {
                pendingCalls.delete(session);
                p.resolve(msg);
                return;
            }
            const t = pendingTimers.get(session);
            if (t) {
                pendingTimers.delete(session);
                t();
                return;
            }
            if (clusterRespHandler) {
                clusterRespHandler(session, msg);
            }
            return;
        }
        if (type === PTYPE_ERROR) {
            const p = pendingCalls.get(session);
            if (p) {
                pendingCalls.delete(session);
                p.reject(new Error("skynet.call: error response from :" + source.toString(16)));
                return;
            }
            if (clusterErrHandler) {
                clusterErrHandler(session, source);
            }
            return;
        }
        const pr = proto[type];
        if (!pr || typeof pr.dispatch !== "function") {
            throw new Error("No dispatch for protocol " + type);
        }
        return pr.dispatch(msg, source, session);
    }

    // C layer wraps globalThis.dispatch with this once, after the user script ran.
    // The wrapper owns response/error sending so handlers can be sync or async
    // uniformly. RESPONSE/ERROR messages are fully handled by internal_dispatch and
    // never produce a reply.
    globalThis.__snjs_wrap = function (ud) {
        // client messages arrive via skynet.redirect with session=fd and must
        // never auto-reply; RESPONSE/ERROR are fully handled by internal_dispatch
        const wantsReply = (session, type) =>
            session !== 0 && type !== PTYPE_RESPONSE && type !== PTYPE_ERROR && type !== PTYPE_CLIENT;
        return function (msg, session, source, type) {
            let ret;
            try {
                ret = ud(msg, session, source, type);
            } catch (e) {
                skynetcore.error("dispatch error: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
                if (wantsReply(session, type)) skynetcore.errorResponse(session, source);
                return;
            }
            if (ret && typeof ret.then === "function") {
                return ret.then(
                    v => {
                        if (wantsReply(session, type)) {
                            // pass through as-is: string or ArrayBuffer (lua payloads)
                            skynetcore.response(session, source, v === undefined ? "" : v);
                        }
                        return v;
                    },
                    e => {
                        skynetcore.error("dispatch rejected: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
                        if (wantsReply(session, type)) {
                            skynetcore.errorResponse(session, source);
                        }
                    }
                );
            }
            if (wantsReply(session, type)) {
                skynetcore.response(session, source, ret === undefined ? "" : ret);
            }
            return ret;
        };
    };

    globalThis.dispatch = internalDispatch;

    // console.* debug surface: every level funnels into the skynet log channel
    // (via skynetcore.error) so output stays unified in the logger, prefixed
    // with the service handle. Non-string values are rendered recursively:
    // Maps as entries, BigInt with a trailing "n", binary as length summaries.
    function toDisplay(v, depth) {
        if (v === null) return "null";
        if (v === undefined) return "undefined";
        const t = typeof v;
        if (t === "string") return v;
        if (t === "number" || t === "boolean") return String(v);
        if (t === "bigint") return String(v) + "n";
        if (t === "function") return "[function " + (v.name || "anonymous") + "]";
        if (depth > 3) return "...";
        if (v instanceof ArrayBuffer) return "<ArrayBuffer " + v.byteLength + ">";
        if (v instanceof Uint8Array) return "<Uint8Array " + v.length + " [" +
            Array.from(v.slice(0, 16)).map(x => x.toString(16).padStart(2, "0")).join(" ") +
            (v.length > 16 ? " ..." : "") + "]>";
        if (v instanceof Array) {
            return "[" + v.map(x => toDisplay(x, depth + 1)).join(", ") + "]";
        }
        if (typeof globalThis.LuaTable === "function" && v instanceof globalThis.LuaTable) {
            const parts = v.array.map(x => toDisplay(x, depth + 1));
            for (const [k, val] of v.hash) {
                parts.push(toDisplay(k, depth + 1) + ": " + toDisplay(val, depth + 1));
            }
            return "LuaTable{ " + parts.join(", ") + " }";
        }
        if (v instanceof Map) {
            return "{ " + Array.from(v.entries()).map(e =>
                toDisplay(e[0], depth + 1) + ": " + toDisplay(e[1], depth + 1)).join(", ") + " }";
        }
        if (t === "object") {
            try {
                return "{ " + Object.keys(v).map(k => k + ": " + toDisplay(v[k], depth + 1)).join(", ") + " }";
            } catch (e) {
                return String(v);
            }
        }
        return String(v);
    }

    function consoleLine(args) {
        return args.map(a => toDisplay(a, 0)).join(" ");
    }

    // printf-style formatting, a subset of node's util.format: enabled only
    // when the first argument is a string holding "%"; unknown specifiers and
    // out-of-argument placeholders stay literal, extra arguments are appended
    const FORMAT_SPECS = "sdifjo%";
    function formatLine(args) {
        if (typeof args[0] !== "string" || args[0].indexOf("%") < 0) {
            return consoleLine(args);
        }
        const fmt = args[0];
        const rest = args.slice(1);
        let ri = 0;
        let out = "";
        for (let i = 0; i < fmt.length; i++) {
            const ch = fmt[i];
            if (ch !== "%" || i + 1 >= fmt.length || FORMAT_SPECS.indexOf(fmt[i + 1]) < 0) {
                out += ch;
                continue;
            }
            const spec = fmt[i + 1];
            i += 1;
            if (spec === "%") { out += "%"; continue; }
            if (ri >= rest.length) { out += "%" + spec; continue; }
            const v = rest[ri++];
            if (spec === "s") {
                out += (typeof v === "string") ? v : toDisplay(v, 0);
            } else if (spec === "d" || spec === "i") {
                const n = (typeof v === "bigint") ? v : parseInt(v, 10);
                out += String(n);
            } else if (spec === "f") {
                out += String(parseFloat(v));
            } else if (spec === "j") {
                try { out += JSON.stringify(v); } catch (e) { out += "[unserializable]"; }
            } else {  // %o / %O
                out += toDisplay(v, 0);
            }
        }
        while (ri < rest.length) {
            out += " " + toDisplay(rest[ri++], 0);
        }
        return out;
    }

    // console.time family: wall-clock via Date.now(), purely observational --
    // nothing here ever suspends a dispatch, so the worker-thread guarantee
    // of the scheduling model is untouched
    const timeLabels = new Map();
    const timeLabel = (label) => (label === undefined ? "default" : label);
    function elapsedLine(prefix, label, args) {
        const t0 = timeLabels.get(label);
        if (t0 === undefined) {
            return prefix + ": no such label '" + label + "'";
        }
        let line = label + ": " + (Date.now() - t0) + "ms";
        if (args.length) line += " " + consoleLine(args);
        return line;
    }

    const consoleObj = {};
    for (const level of ["log", "info", "debug", "warn", "error", "trace"]) {
        consoleObj[level] = function (...args) { skynetcore.error(formatLine(args)); };
    }
    // standard console API names (web/node surface), like console.log itself
    consoleObj.time = function (label) {
        timeLabels.set(timeLabel(label), Date.now());
    };
    consoleObj.timeLog = function (label, ...args) {
        const k = timeLabel(label);
        skynetcore.error(elapsedLine("console.timeLog", k, args));
    };
    consoleObj.timeEnd = function (label, ...args) {
        const k = timeLabel(label);
        skynetcore.error(elapsedLine("console.timeEnd", k, args));
        timeLabels.delete(k);
    };
    globalThis.console = consoleObj;

    // skynet.getenv: the C layer (platform/main.c) stashes the raw JSON config
    // text under "__json_config" and flattens primitive top-level keys into the
    // env store. We parse the raw text once (lazily) so JS callers get full
    // types (numbers/booleans/nested objects/arrays); the parsed config is
    // deep-frozen so it stays an immutable shared view. Keys absent from the
    // JSON (e.g. C-side defaults set via optint/optstring) fall back to the
    // flat env string via GETENV.
    let _config = null;

    function deepFreeze(obj) {
        if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
            Object.freeze(obj);
            Object.values(obj).forEach(deepFreeze);
        }
        return obj;
    }

    function skynetGetenv(key) {
        if (!_config) {
            const raw = skynetcore.command("GETENV", "__json_config");
            _config = deepFreeze(raw ? JSON.parse(raw) : {});
        }
        if (key in _config) {
            return _config[key];
        }
        return skynetcore.command("GETENV", key);
    }

    globalThis.skynet = {
        PTYPE_TEXT, PTYPE_RESPONSE, PTYPE_ERROR, PTYPE_LUA, PTYPE_CLIENT,
        version: skynetcore.runtime.info().version,
        features: function () { return skynetcore.features(); },
        start: function (startFunc) { startFunc(); },
        dispatch: skynetDispatch,
        registerProtocol,
        call: skynetCall,
        send: skynetSend,
        redirect: skynetRedirect,
        timeout: skynetTimeout,
        sleep: skynetSleep,
        fork: skynetFork,
        newservice: skynetNewservice,
        self: skynetSelf,
        register: skynetRegister,
        getenv: skynetGetenv,
        now: function () { return skynetcore.now(); },
        memStat: function () { return skynetcore.mem(); },
        pack: function (...args) { return skynetcore.pack(...args); },
        unpack: function (buf) { return skynetcore.unpack(buf); },
        exit: function () { skynetcore.command("EXIT"); },
    };
})();
