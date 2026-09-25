"use strict";

// CommonJS loader for SkyJS. snjs evaluates this file as a plain script (the
// loader cannot require itself), captures the two private C entry points, and
// then requires js/bootstrap.js. `require` remains a module-local parameter.

(function () {
    const moduleRealpath = globalThis.__snjs_realpath;
    delete globalThis.__snjs_realpath;

    const cwd = moduleRealpath(".");
    let pathPosix = null;

    function dirnameOf(filename) {
        const slash = filename.lastIndexOf("/");
        if (slash < 0) return ".";
        if (slash === 0) return "/";
        return filename.slice(0, slash);
    }

    function moduleError(message, code) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    function notFound(request) {
        return moduleError("Cannot find module '" + request + "'", "MODULE_NOT_FOUND");
    }

    function readSource(filename) {
        const source = skynetcore.runtime.readModuleSource(filename);
        return source === null || source === undefined ? null : source;
    }

    function tryFile(filename) {
        const canonical = moduleRealpath(filename);
        if (canonical === null) return null;
        const source = readSource(canonical);
        if (source === null) return null;
        return { filename: canonical, source };
    }

    function tryExtensions(filename) {
        return tryFile(filename) || tryFile(filename + ".js") ||
            tryFile(filename + ".json");
    }

    function directoryPath(directory) {
        const normalized = pathPosix.normalize(directory);
        return normalized === "/" ? "/" : normalized.replace(/\/+$/, "");
    }

    // Package roots discovered during resolution: filename -> { root, manifest }.
    // Used by _load to attach module.native for packages declaring skyjs.native.
    const packageInfo = new Map();

    function tryDirectory(directory) {
        const root = moduleRealpath(directoryPath(directory));
        if (root === null) return null;

        const packageFile = tryFile(pathPosix.join(root, "package.json"));
        if (packageFile !== null) {
            const metadata = JSON.parse(packageFile.source);
            if (typeof metadata.main === "string" && metadata.main !== "") {
                const main = pathPosix.join(root, metadata.main);
                const found = tryExtensions(main) || tryDirectory(main);
                if (found !== null) {
                    if (metadata.skyjs !== undefined) {
                        packageInfo.set(found.filename,
                            { root, manifest: metadata });
                    }
                    return found;
                }
            }
        }
        const index = tryExtensions(pathPosix.join(root, "index.js")) ||
            tryExtensions(pathPosix.join(root, "index.json"));
        return index;
    }

    function tryPathOrDirectory(filename) {
        if (filename.endsWith("/")) return tryDirectory(filename);
        return tryExtensions(filename) || tryDirectory(filename);
    }

    function tryEngineModule(id) {
        return tryFile(id) || tryFile(id + ".js") ||
            tryFile(id + "/index.js") || tryFile(id + "/index.json");
    }

    function searchNodeModules(request, parent) {
        let directory = parent === undefined ?
            cwd : pathPosix.dirname(parent.filename);
        for (;;) {
            const candidate = pathPosix.join(directory, "node_modules", request);
            const found = tryPathOrDirectory(candidate);
            if (found !== null) return found;
            const parentDirectory = pathPosix.dirname(directory);
            if (parentDirectory === directory) break;
            directory = parentDirectory;
        }
        return null;
    }

    function resolveFileRequest(request, parent) {
        if (request.startsWith("/")) {
            const found = tryPathOrDirectory(pathPosix.normalize(request));
            if (found !== null) return found;
        } else if (request.startsWith("./") || request.startsWith("../")) {
            const base = parent === undefined ? cwd : pathPosix.dirname(parent.filename);
            const found = tryPathOrDirectory(pathPosix.join(base, request));
            if (found !== null) return found;
        } else {
            const found = searchNodeModules(request, parent);
            if (found !== null) return found;
        }
        throw notFound(request);
    }

    class Module {
        constructor(id, isMain) {
            this.id = isMain ? "." : id;
            this.filename = id;
            this.loaded = false;
            this.exports = {};
        }

        require(request) {
            return Module._load(request, this, false);
        }
    }

    Module._cache = new Map();
    Module._registry = null;

    Module.wrap = function (script) {
        return "(function (exports, require, module, __filename, __dirname) {" +
            script + "\n});";
    };

    // Indirect eval keeps the wrapper non-strict. Each module's own leading
    // "use strict" directive then controls its strictness, matching CJS.

    Module._resolveFilename = function (request, parent) {
        if (typeof request !== "string" || request === "") {
            throw new TypeError("request must be a non-empty string");
        }

        const resolvedRequest = request.startsWith("node:") ?
            request.slice(5) : request;
        const isInternalRequest = resolvedRequest.startsWith("internal/") ||
            resolvedRequest.startsWith("js/internal/");
        if (isInternalRequest) {
            const allowed = Module._registry === null ||
                Module._registry.isInternalAllowed(parent === undefined ?
                    undefined : parent.filename);
            if (!allowed) {
                throw moduleError("Permission denied for module '" + request + "'",
                    "ERR_PERMISSION");
            }
            const id = resolvedRequest.startsWith("internal/") ?
                resolvedRequest : resolvedRequest.slice(3);
            const found = tryEngineModule(id);
            if (found === null) throw notFound(request);
            return found.filename;
        }

        const entry = Module._registry === null ?
            null : Module._registry.resolve(request);
        if (entry !== null) {
            const found = tryEngineModule(entry.id);
            if (found !== null) return found.filename;
            if (entry.fallback === null || entry.fallback === undefined) {
                throw notFound(request);
            }
            return resolveFileRequest(entry.fallback, parent).filename;
        }
        return resolveFileRequest(request, parent).filename;
    };

    Module._load = function (request, parent, isMain) {
        const filename = Module._resolveFilename(request, parent);
        const cached = Module._cache.get(filename);
        if (cached !== undefined) return cached.exports;

        const module = new Module(filename, isMain);
        Module._cache.set(filename, module);
        try {
            if (filename.endsWith(".json")) {
                const source = readSource(filename);
                if (source === null) throw notFound(request);
                module.exports = JSON.parse(source);
            } else {
                const source = readSource(filename);
                if (source === null) throw notFound(request);
                const packageMeta = packageInfo.get(filename);
                if (packageMeta !== undefined &&
                        packageMeta.manifest.skyjs !== undefined &&
                        packageMeta.manifest.skyjs.native !== undefined) {
                    // §3.4.3: static first, dynamic second; may throw
                    // ERR_UNSUPPORTED_PLATFORM when the capability is absent.
                    const nativeLoader = Module._load("internal/native-loader.js",
                        undefined, false);
                    const pkgName = packageMeta.manifest.name || filename;
                    const namespace = {};
                    const loaded = nativeLoader.load(pkgName, packageMeta.root,
                        packageMeta.manifest, namespace);
                    module.native = loaded === null ? undefined : loaded.exports;
                }
                const wrapper = (0, eval)(Module.wrap(source));
                wrapper.call(module.exports, module.exports,
                    module.require.bind(module), module, filename,
                    pathPosix === null ? dirnameOf(filename) :
                        pathPosix.dirname(filename));
            }
            module.loaded = true;
        } catch (err) {
            Module._cache.delete(filename);
            throw err;
        }
        return module.exports;
    };

    Module.runMain = function (entry) {
        const filename = pathPosix.resolve(cwd, entry);
        return Module._load(filename, undefined, true);
    };

    pathPosix = Module._load("internal/path-posix.js", undefined, false);
    pathPosix.setCwd(cwd);

    const bootstrapPath = globalThis.__snjs_bootstrap;
    const main = globalThis.__snjs_main;
    const param = globalThis.__snjs_param;
    delete globalThis.__snjs_bootstrap;
    delete globalThis.__snjs_main;
    delete globalThis.__snjs_param;

    const bootstrap = Module._load(bootstrapPath, undefined, false);
    bootstrap.runMain(Module, main, param);
})();
