"use strict";

// Node-compatible `util` subset: format/inspect/promisify/callbackify/types
// and the deprecated helpers still used by common code.

const types = require("../internal/util-types.js");

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

function formatWithOptions(options, first, ...rest) {
    return formatInternal(first, rest, options);
}

function format(first, ...rest) {
    return formatInternal(first, rest, {});
}

function formatInternal(first, rest, options) {
    // Node rule: a non-string first argument (or no % specifiers) joins the
    // inspected arguments verbatim, without quoting strings.
    if (typeof first !== "string" || !/%[sdifjoOc]/.test(first)) {
        const parts = [inspect(first, Object.assign({}, options, { plain: true }))];
        for (const value of rest) {
            parts.push(inspect(value, Object.assign({}, options, { plain: true })));
        }
        return parts.join(" ");
    }

    let index = 0;
    let out = first.replace(/%[sdifjoOc]/g, (spec) => {
        if (index >= rest.length) return spec;
        const value = rest[index++];
        switch (spec) {
            case "%s": return typeof value === "string" ? value : inspect(value, options);
            case "%d": return String(Number(value));
            case "%i": return String(parseInt(value, 10));
            case "%f": return String(parseFloat(value));
            case "%j": return safeJson(value);
            case "%c": return "";
            default: return inspect(value, Object.assign({}, options, { length: true }));
        }
    });
    while (index < rest.length) {
        out += " " + inspect(rest[index++], { plain: true });
    }
    return out;
}

function safeJson(value) {
    try {
        return JSON.stringify(value);
    } catch (err) {
        return "[Circular]";
    }
}

function inspect(value, options, depth) {
    const opts = typeof options === "boolean" ? { showHidden: options } : (options || {});
    const maxDepth = typeof opts.depth === "number" ? opts.depth : 2;
    const current = depth === undefined ? 0 : depth;
    if (value === null) return "null";
    const type = typeof value;
    if (type === "string") return opts.plain ? value : "'" + value + "'";
    if (type === "number" || type === "boolean" || type === "bigint" ||
        type === "undefined") {
        return type === "bigint" ? String(value) + "n" : String(value);
    }
    if (type === "symbol") return value.toString();
    if (type === "function") return "[Function: " + (value.name || "anonymous") + "]";
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
    if (value[inspectCustom]) return String(value[inspectCustom]());
    if (current >= maxDepth) return Array.isArray(value) ? "[Array]" : "[Object]";
    if (Array.isArray(value)) {
        const body = value.map((item) => inspect(item, opts, current + 1));
        if (opts.length) body.push("[length]: " + value.length);
        return "[ " + body.join(", ") + " ]";
    }
    if (value instanceof Map) {
        const body = Array.from(value.entries())
            .map(([k, v]) => inspect(k, opts, current + 1) + " => " +
                inspect(v, opts, current + 1)).join(", ");
        return "Map(" + value.size + ") { " + body + " }";
    }
    if (value instanceof Set) {
        const body = Array.from(value.values())
            .map((v) => inspect(v, opts, current + 1)).join(", ");
        return "Set(" + value.size + ") { " + body + " }";
    }
    if (ArrayBuffer.isView(value)) {
        const ctor = value.constructor ? value.constructor.name : "TypedArray";
        return ctor + "(" + value.length + ") [ " +
            Array.from(value).join(", ") + " ]";
    }
    if (value instanceof ArrayBuffer) {
        return "ArrayBuffer { byteLength: " + value.byteLength + " }";
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    return "{ " + keys.map((key) =>
        key + ": " + inspect(value[key], opts, current + 1)).join(", ") + " }";
}

/** util.inspect.custom-compatible symbol. */
inspect.custom = inspectCustom;

function promisify(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("The \"original\" argument must be of type function");
    }
    if (fn[promisify.custom]) return fn[promisify.custom];
    function promisified(...args) {
        return new Promise((resolve, reject) => {
            args.push((err, value) => err ? reject(err) : resolve(value));
            fn.apply(this, args);
        });
    }
    Object.setPrototypeOf(promisified, Object.getPrototypeOf(fn));
    Object.defineProperty(promisified, "name", { value: fn.name, configurable: true });
    return promisified;
}
promisify.custom = Symbol.for("nodejs.util.promisify.custom");

function callbackify(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("The \"original\" argument must be of type function");
    }
    return function callbackified(...args) {
        const callback = args.pop();
        if (typeof callback !== "function") {
            throw new TypeError("The last argument must be of type function");
        }
        fn.apply(this, args).then(
            (value) => queueMicrotask(() => callback(null, value)),
            (err) => queueMicrotask(() => callback(err || new Error("Rejected"))),
        );
    };
}
callbackify.custom = Symbol.for("nodejs.util.callbackify.custom");

function deprecate(fn, string) {
    let warned = false;
    return function deprecated(...args) {
        if (!warned) {
            warned = true;
            if (typeof process !== "undefined" && process.emitWarning) {
                process.emitWarning(string, "DeprecationWarning");
            } else {
                skynetcore.runtime.error("DeprecationWarning: " + string);
            }
        }
        return fn.apply(this, args);
    };
}

function inherits(ctor, superCtor) {
    if (ctor === undefined || ctor === null) {
        throw new TypeError("The constructor to \"inherit\" must be a function");
    }
    if (superCtor === undefined || superCtor === null) {
        throw new TypeError("The super constructor to \"inherit\" must not be null");
    }
    ctor.super_ = superCtor;
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

function getSystemErrorName(errno) {
    return require("../internal/errors.js").systemErrorName(errno);
}

function getSystemErrorMessage(errno) {
    return "Unknown system error " + errno;
}

function isDeepStrictEqual(a, b) {
    return deepEqual(a, b, new Set());
}

function deepEqual(a, b, seen) {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return false;
    }
    if (seen.has(a)) return seen.get(a) === b;
    seen.add(a);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!deepEqual(a[key], b[key], seen)) return false;
    }
    return true;
}

module.exports = {
    format,
    formatWithOptions,
    inspect,
    promisify,
    callbackify,
    deprecate,
    inherits,
    getSystemErrorName,
    getSystemErrorMessage,
    isDeepStrictEqual,
    types,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
};
