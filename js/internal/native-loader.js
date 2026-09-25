"use strict";

// Third-party C bridge loader (docs/node-compatibility.md §3.4.3).
//
// Selection order is fixed: static registry first, dynamic dlopen second. Only
// the two fixed entry symbols are ever resolved, so this is not a generic FFI
// surface. The loader reads package.json, decides the platform key, and injects
// `module.native`; all path validation happens in C (skynetcore.native.*).

const errors = require("./errors.js");
const path = require("./path-posix.js");

const SUPPORTED_ABI = 1;
const platformKey = (platform, arch) => platform + "-" + arch;

function runtimeInfo() {
    return skynetcore.runtime.info();
}

function unsupported(message) {
    return errors.skyjsError("ERR_UNSUPPORTED_PLATFORM", message);
}

/** Resolve the platform-specific native entry from a package manifest. */
function nativeEntryFor(manifest, platform, arch) {
    const spec = manifest && manifest.skyjs && manifest.skyjs.native;
    if (spec === undefined || spec === null) return null;
    if (typeof spec === "string") return { relPath: spec, abi: manifest.skyjs.abi };
    const key = platformKey(platform, arch);
    if (typeof spec !== "object" || spec[key] === undefined) return null;
    return { relPath: spec[key], abi: manifest.skyjs.abi };
}

function toAbsolute(pkgRoot, relPath) {
    if (relPath.startsWith("/")) return relPath;
    return path.join(pkgRoot, relPath);
}

/**
 * Load a package's native bridge.
 * @returns { exports, abi, mode: "static" | "dynamic" } or null when the
 *          package declares no native binding.
 */
function load(pkgName, pkgRoot, manifest, namespace) {
    const native = skynetcore.native;
    if (native === undefined || native === null) {
        // NATIVE_EXT=0: capability not compiled in (§3.4.5).
        throw unsupported("native C bridges are not compiled into this build (NATIVE_EXT=0)");
    }

    const info = runtimeInfo();
    const entry = nativeEntryFor(manifest, info.platform, info.arch);

    // 1) static registry (mobile / STATIC builds); no extpath, no dlopen.
    const staticExports = native.initStatic(pkgName, namespace);
    if (staticExports !== null && staticExports !== undefined) {
        return { exports: staticExports, abi: SUPPORTED_ABI, mode: "static" };
    }

    // 2) dynamic loading requires NATIVE_EXT + a non-empty extpath.
    if (!native.dynamicEnabled()) {
        if (entry === null) return null;
        throw unsupported("dynamic native loading requires a non-empty extpath");
    }

    let absolute;
    if (entry !== null) {
        const resolved = native.resolve(pkgRoot, entry.relPath);
        if (resolved === null) {
            throw errors.skyjsError("ERR_NOT_FOUND",
                "skyjs.native entry not found: " + entry.relPath,
                { pkg: pkgName, rel: entry.relPath, detail: native.errmsg() });
        }
        absolute = resolved;
    } else {
        // No skyjs.native declaration: fall back to the extpath search roots.
        absolute = native.find(pkgName, info.platform, info.arch);
        if (absolute === null) return null;
    }

    const handle = native.load(absolute);
    if (handle === null) {
        throw errors.skyjsError("ERR_IO",
            "failed to load native bridge: " + absolute,
            { detail: native.errmsg() });
    }

    const abi = native.abi(handle);
    if (abi === 0) {
        native.unload(handle);
        throw errors.skyjsError("ERR_PROTOCOL",
            "native bridge is missing skyjs_ext_abi: " + absolute,
            { detail: native.errmsg() });
    }
    if (abi !== SUPPORTED_ABI) {
        native.unload(handle);
        throw errors.skyjsError("ERR_PROTOCOL",
            "native bridge ABI mismatch: extension " + abi + " vs runtime " + SUPPORTED_ABI,
            { pkg: pkgName, abi });
    }
    if (entry !== null && entry.abi !== undefined && entry.abi !== abi) {
        native.unload(handle);
        throw errors.skyjsError("ERR_PROTOCOL",
            "package.json#skyjs.abi disagrees with the C symbol",
            { pkg: pkgName, declared: entry.abi, symbol: abi });
    }

    const exports = native.init(handle, namespace);
    return { exports, abi, mode: "dynamic", handle };
}

module.exports = { load, nativeEntryFor, SUPPORTED_ABI };
