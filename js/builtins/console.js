"use strict";

// console.* maps to the skynet log channel. Non-string values are rendered
// recursively (Maps as entries, BigInt with "n", binary as length summaries),
// matching the pre-refactor console surface.

const timeLabels = new Map();

function toDisplay(value, depth) {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    const type = typeof value;
    if (type === "string") return value;
    if (type === "number" || type === "boolean") return String(value);
    if (type === "bigint") return String(value) + "n";
    if (type === "function") return "[function " + (value.name || "anonymous") + "]";
    if (depth > 3) return "...";
    if (value instanceof ArrayBuffer) return "<ArrayBuffer " + value.byteLength + ">";
    if (value instanceof Uint8Array) return "<Uint8Array " + value.length + " [" +
        Array.from(value.slice(0, 16)).map((x) => x.toString(16).padStart(2, "0")).join(" ") +
        (value.length > 16 ? " ..." : "") + "]>";
    if (value instanceof Array) {
        return "[" + value.map((item) => toDisplay(item, depth + 1)).join(", ") + "]";
    }
    if (typeof globalThis.LuaTable === "function" && value instanceof globalThis.LuaTable) {
        const parts = value.array.map((item) => toDisplay(item, depth + 1));
        for (const [key, item] of value.hash) {
            parts.push(toDisplay(key, depth + 1) + ": " + toDisplay(item, depth + 1));
        }
        return "LuaTable{ " + parts.join(", ") + " }";
    }
    if (value instanceof Map) {
        return "{ " + Array.from(value.entries()).map((entry) =>
            toDisplay(entry[0], depth + 1) + ": " + toDisplay(entry[1], depth + 1)).join(", ") + " }";
    }
    if (type === "object") {
        try {
            return "{ " + Object.keys(value).map((key) =>
                key + ": " + toDisplay(value[key], depth + 1)).join(", ") + " }";
        } catch (err) {
            return String(value);
        }
    }
    return String(value);
}

function consoleLine(args) {
    return args.map((item) => toDisplay(item, 0)).join(" ");
}

const FORMAT_SPECS = "sdifjo%";

function formatLine(args) {
    if (typeof args[0] !== "string" || args[0].indexOf("%") < 0) {
        return consoleLine(args);
    }
    const fmt = args[0];
    const rest = args.slice(1);
    let restIndex = 0;
    let out = "";
    for (let i = 0; i < fmt.length; i++) {
        const ch = fmt[i];
        if (ch !== "%" || i + 1 >= fmt.length || FORMAT_SPECS.indexOf(fmt[i + 1]) < 0) {
            out += ch;
            continue;
        }
        const spec = fmt[i + 1];
        i += 1;
        if (spec === "%") {
            out += "%";
            continue;
        }
        if (restIndex >= rest.length) {
            out += "%" + spec;
            continue;
        }
        const value = rest[restIndex++];
        if (spec === "s") {
            out += (typeof value === "string") ? value : toDisplay(value, 0);
        } else if (spec === "d" || spec === "i") {
            out += String(typeof value === "bigint" ? value : parseInt(value, 10));
        } else if (spec === "f") {
            out += String(parseFloat(value));
        } else if (spec === "j") {
            try { out += JSON.stringify(value); } catch (err) { out += "[unserializable]"; }
        } else {
            out += toDisplay(value, 0);
        }
    }
    while (restIndex < rest.length) {
        out += " " + toDisplay(rest[restIndex++], 0);
    }
    return out;
}

function timeLabel(label) {
    return label === undefined ? "default" : label;
}

function elapsedLine(prefix, label, args) {
    const start = timeLabels.get(label);
    if (start === undefined) {
        return prefix + ": no such label '" + label + "'";
    }
    let line = label + ": " + (Date.now() - start) + "ms";
    if (args.length) line += " " + consoleLine(args);
    return line;
}

const consoleObject = {};
for (const level of ["log", "info", "debug", "warn", "error", "trace"]) {
    consoleObject[level] = function (...args) {
        skynetcore.error(formatLine(args));
    };
}
consoleObject.time = function (label) {
    timeLabels.set(timeLabel(label), Date.now());
};
consoleObject.timeLog = function (label, ...args) {
    skynetcore.error(elapsedLine("console.timeLog", timeLabel(label), args));
};
consoleObject.timeEnd = function (label, ...args) {
    const key = timeLabel(label);
    skynetcore.error(elapsedLine("console.timeEnd", key, args));
    timeLabels.delete(key);
};

module.exports = consoleObject;
module.exports.toDisplay = toDisplay;
module.exports.formatLine = formatLine;
