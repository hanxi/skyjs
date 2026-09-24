// skyjs async service core (Task 3).
// Loaded by snjs before the user script (env key "jsLoader",
// default "./js/internal/skynet-core.js").
//
// Scheduling model (isomorphic to lualib/skynet.lua):
//   skynet.lua                     skynet.js
//   session <-> coroutine map      session <-> {resolve, reject} in pending_calls
//   coroutine.yield()              await (dispatch returns a Promise)
//   wakeup via resume              resolve() on the matching response message
// Every await waits on an external event (response/timer), so the pending-job
// queue always drains before the C dispatch returns the worker thread.
//
// Structure note: everything lives in an IIFE; only globalThis.skynet and the
// __snjs_* C-layer contracts remain global.

(function () {
    "use strict";

    // The C host loads this file once as a plain global script; a later
    // require() must reuse that instance instead of re-installing the routing
    // state and clobbering globalThis.dispatch.
    if (globalThis.skynet !== undefined) {
        if (typeof module !== "undefined" && module.exports) {
            module.exports = globalThis.skynet;
        }
        return;
    }

    const PTYPE_TEXT = 0;
    const PTYPE_RESPONSE = 1;
    const PTYPE_CLIENT = 3;
    const PTYPE_ERROR = 7;
    const PTYPE_LUA = 10;
    const PTYPE_SOCKET = 6;

    const hooks = require("./runtime-hooks.js");
    const proto = {};                 // id -> { name, id, dispatch }
    const pendingCalls = new Map();   // session -> { resolve, reject }
    const pendingTimers = new Map();  // session -> fn

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
        const session = skynetcore.runtime.genId();
        // responses cross as raw bytes (binary-safe); text protocols decode here
        const isBinary = (type === PTYPE_LUA);
        return new Promise((resolve, reject) => {
            pendingCalls.set(session, {
                resolve: v => resolve(isBinary ? v : (v instanceof ArrayBuffer ? skynetcore.seri.str(v) : v)),
                reject,
            });
            // ArrayBuffer payloads (skynet.pack) cross untouched; everything else
            // is coerced to its string form
            const payload = (msg === undefined || msg === null) ? "" : msg;
            const r = skynetcore.runtime.send(addr, type, payload, session);
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
            ? skynetcore.seri.pack(...args)
            : (args.length === 0 || args[0] === undefined || args[0] === null ? "" : args[0]);
        return skynetcore.runtime.send(addr, type, payload, 0);
    }

    // redirect: forward a message with a spoofed source (skynet.redirect).
    // msg crosses untouched (string or ArrayBuffer, e.g. a raw client frame).
    function skynetRedirect(dest, source, typename, session, msg) {
        const type = findType(typename);
        return skynetcore.runtime.redirect(dest, source, type, session | 0,
            (msg === undefined || msg === null) ? "" : msg);
    }

    function skynetTimeout(ti, fn) {
        // ti is in centiseconds (10ms units), same as skynet.lua
        const s = skynetcore.runtime.intCommand("TIMEOUT", String(ti));
        pendingTimers.set(s, fn);
        return s;
    }

    function skynetSleep(ms) {
        return new Promise(resolve => skynetTimeout(Math.max(1, Math.round(ms / 10)), resolve));
    }

    function skynetFork(fn) {
        return Promise.resolve().then(fn).catch((e) => {
            skynetcore.runtime.error("fork error: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
        });
    }

    function skynetNewservice(name, param) {
        return skynetcore.runtime.intCommand("LAUNCH", param ? (name + " " + param) : name);
    }

    function skynetSelf() {
        const r = skynetcore.runtime.command("REG");   // ":hex"
        return r ? parseInt(r.slice(1), 16) : 0;
    }

    function skynetRegister(name) {
        const self = skynetcore.runtime.command("REG");
        skynetcore.runtime.command("NAME", "." + name + " " + self);
    }

    // socket events come pre-parsed as {type, id, ud, data} objects (snjs.c);
    // internal/net-core.js installs the actual handler via __snjs_set_socket_handler.
    // internal router: the C layer calls this (through __snjs_wrap) for every message
    function internalDispatch(msg, session, source, type) {
        if (type === PTYPE_SOCKET) {
            const socketHandler = hooks.getSocketHandler();
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
            const clusterHandlers = hooks.getClusterHandlers();
            if (clusterHandlers.response) {
                clusterHandlers.response(session, msg);
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
            const clusterHandlers = hooks.getClusterHandlers();
            if (clusterHandlers.error) {
                clusterHandlers.error(session, source);
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
                skynetcore.runtime.error("dispatch error: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
                if (wantsReply(session, type)) skynetcore.runtime.errorResponse(session, source);
                return;
            }
            if (ret && typeof ret.then === "function") {
                return ret.then(
                    v => {
                        if (wantsReply(session, type)) {
                            // pass through as-is: string or ArrayBuffer (lua payloads)
                            skynetcore.runtime.response(session, source, v === undefined ? "" : v);
                        }
                        return v;
                    },
                    e => {
                        skynetcore.runtime.error("dispatch rejected: " + (e && (e.message || e)) + "\n" + (e && e.stack || ""));
                        if (wantsReply(session, type)) {
                            skynetcore.runtime.errorResponse(session, source);
                        }
                    }
                );
            }
            if (wantsReply(session, type)) {
                skynetcore.runtime.response(session, source, ret === undefined ? "" : ret);
            }
            return ret;
        };
    };

    globalThis.dispatch = internalDispatch;

    // console.* debug surface: every level funnels into the skynet log channel
    // (via skynetcore.runtime.error) so output stays unified in the logger, prefixed
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
        consoleObj[level] = function (...args) { skynetcore.runtime.error(formatLine(args)); };
    }
    // standard console API names (web/node surface), like console.log itself
    consoleObj.time = function (label) {
        timeLabels.set(timeLabel(label), Date.now());
    };
    consoleObj.timeLog = function (label, ...args) {
        const k = timeLabel(label);
        skynetcore.runtime.error(elapsedLine("console.timeLog", k, args));
    };
    consoleObj.timeEnd = function (label, ...args) {
        const k = timeLabel(label);
        skynetcore.runtime.error(elapsedLine("console.timeEnd", k, args));
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
            const raw = skynetcore.runtime.command("GETENV", "__json_config");
            _config = deepFreeze(raw ? JSON.parse(raw) : {});
        }
        if (key in _config) {
            return _config[key];
        }
        return skynetcore.runtime.command("GETENV", key);
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
        now: function () { return skynetcore.runtime.now(); },
        memStat: function () { return skynetcore.runtime.mem(); },
        pack: function (...args) { return skynetcore.seri.pack(...args); },
        unpack: function (buf) { return skynetcore.seri.unpack(buf); },
        exit: function () { skynetcore.runtime.command("EXIT"); },
    };
    if (typeof module !== "undefined" && module.exports) {
        module.exports = globalThis.skynet;
    }
})();
