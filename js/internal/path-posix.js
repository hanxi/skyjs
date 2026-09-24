"use strict";

// POSIX path semantics shared by the CJS loader and the future `path` module.
// This file is intentionally dependency-free so it can load before the module
// registry is populated.

let currentCwd = "/";

function checkPath(value) {
    if (typeof value !== "string") {
        throw new TypeError("Path must be a string");
    }
    return value;
}

function splitPath(value) {
    const out = [];
    const absolute = value.startsWith("/");
    for (const part of value.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (out.length > 0 && out[out.length - 1] !== "..") {
                out.pop();
            } else if (!absolute) {
                out.push("..");
            }
        } else {
            out.push(part);
        }
    }
    return out;
}

function normalize(value) {
    checkPath(value);
    const absolute = value.startsWith("/");
    const trailingSlash = value.length > 1 && value.endsWith("/");
    const parts = splitPath(value);
    let out = (absolute ? "/" : "") + parts.join("/");
    if (out === "") out = ".";
    if (trailingSlash && out !== "/") out += "/";
    return out;
}

function join(...values) {
    if (values.length === 0) return ".";
    return normalize(values.map(checkPath).filter((value) => value !== "").join("/"));
}

function resolve(...values) {
    let result = currentCwd;
    for (const value of values) {
        checkPath(value);
        if (value.startsWith("/")) {
            result = value;
        } else if (value !== "") {
            result = result + "/" + value;
        }
    }
    const normalized = normalize(result);
    if (normalized !== "/" && normalized.endsWith("/")) {
        return normalized.slice(0, -1);
    }
    return normalized;
}

function dirname(value) {
    checkPath(value);
    if (value.length === 0) return ".";
    const hasRoot = value.charCodeAt(0) === 47;
    let end = -1;
    let matchedSlash = true;
    for (let i = value.length - 1; i >= 1; i--) {
        const code = value.charCodeAt(i);
        if (code === 47) {
            if (!matchedSlash) {
                end = i;
                break;
            }
        } else {
            matchedSlash = false;
        }
    }
    if (end === -1) return hasRoot ? "/" : ".";
    if (hasRoot && end === 1) return "//";
    return value.slice(0, end);
}

function basename(value, suffix) {
    checkPath(value);
    let start = 0;
    let end = -1;
    let matchedSlash = true;

    if (suffix !== undefined) {
        checkPath(suffix);
        if (suffix.length > 0 && suffix.length <= value.length) {
            if (suffix === value) return "";
            let suffixIndex = suffix.length - 1;
            let firstNonSlashEnd = -1;
            for (let i = value.length - 1; i >= 0; i--) {
                const code = value.charCodeAt(i);
                if (code === 47) {
                    if (!matchedSlash) {
                        start = i + 1;
                        break;
                    }
                } else {
                    if (firstNonSlashEnd === -1) {
                        matchedSlash = false;
                        firstNonSlashEnd = i + 1;
                    }
                    if (suffixIndex >= 0) {
                        if (code === suffix.charCodeAt(suffixIndex)) {
                            suffixIndex -= 1;
                            if (suffixIndex === -1) end = i;
                        } else {
                            suffixIndex = -1;
                            end = firstNonSlashEnd;
                        }
                    }
                }
            }
            if (start === end) end = firstNonSlashEnd;
            else if (end === -1) end = value.length;
            return value.slice(start, end);
        }
    }

    for (let i = value.length - 1; i >= 0; i--) {
        const code = value.charCodeAt(i);
        if (code === 47) {
            if (!matchedSlash) {
                start = i + 1;
                break;
            }
        } else if (end === -1) {
            matchedSlash = false;
            end = i + 1;
        }
    }
    if (end === -1) return "";
    return value.slice(start, end);
}

function extname(value) {
    checkPath(value);
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;

    for (let i = value.length - 1; i >= 0; i--) {
        const char = value[i];
        if (char === "/") {
            if (!matchedSlash) {
                startPart = i + 1;
                break;
            }
            continue;
        }
        if (end === -1) {
            matchedSlash = false;
            end = i + 1;
        }
        if (char === ".") {
            if (startDot === -1) {
                startDot = i;
            } else if (preDotState !== 1) {
                preDotState = 1;
            }
        } else if (startDot !== -1) {
            preDotState = -1;
        }
    }

    if (startDot === -1 || end === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 &&
            startDot === startPart + 1)) {
        return "";
    }
    return value.slice(startDot, end);
}

function relative(from, to) {
    const fromAbs = resolve(from);
    const toAbs = resolve(to);
    if (fromAbs === toAbs) return "";
    const fromParts = fromAbs === "/" ? [] : splitPath(fromAbs);
    const toParts = toAbs === "/" ? [] : splitPath(toAbs);
    let common = 0;
    while (common < fromParts.length && common < toParts.length &&
        fromParts[common] === toParts[common]) {
        common++;
    }
    const up = fromParts.slice(common).map(() => "..");
    const down = toParts.slice(common);
    return normalize(up.concat(down).join("/")) || ".";
}

function isAbsolute(value) {
    checkPath(value);
    return value.startsWith("/");
}

function setCwd(value) {
    currentCwd = normalize(resolve(value));
    return currentCwd;
}

module.exports = {
    normalize,
    join,
    resolve,
    dirname,
    basename,
    extname,
    relative,
    isAbsolute,
    setCwd,
};
