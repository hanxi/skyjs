// skyjs file I/O core (Phase B).
// Shared by the legacy lazy global and the skyjs/fsx entry; wraps the
// C-layer skynetcore.fs.* primitives with convenience sugar:
//   - read_file / read_text_file / write_file / append_file (whole-file)
//   - exists / stat / readdir / mkdir / remove / rename (metadata)
//   - File class for streaming read/write/seek/tell/close
(function () {
    "use strict";

    const cio = skynetcore.fs;

    // ---- data coercion helper ----
    // Accepts string | ArrayBuffer | TypedArray, returns ArrayBuffer.
    function toAb(data) {
        if (data instanceof ArrayBuffer) return data;
        if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        if (typeof data === "string") return cio.str2ab(data);
        throw new TypeError("io: data must be string, ArrayBuffer, or TypedArray");
    }

    // ---- whole-file ----

    function readFile(path) {
        return cio.readFile(path);
    }

    function readTextFile(path) {
        return skynetcore.str(cio.readFile(path));
    }

    function writeFile(path, data) {
        return cio.writeFile(path, toAb(data));
    }

    function appendFile(path, data) {
        return cio.appendFile(path, toAb(data));
    }

    // ---- metadata / directory ----

    function exists(path) {
        return cio.exists(path);
    }

    function stat(path) {
        return cio.stat(path);
    }

    function readdir(path) {
        return cio.readdir(path);
    }

    function mkdir(path, recursive) {
        if (recursive) {
            const parts = path.split("/");
            let cur = "";
            for (let i = 0; i < parts.length; i++) {
                if (i === 0 && parts[i] === "") {
                    cur = "/";
                    continue;
                }
                if (parts[i] === "") continue;
                cur = cur ? cur + "/" + parts[i] : parts[i];
                cio.mkdir(cur);
            }
            return;
        }
        return cio.mkdir(path);
    }

    function remove(path) {
        return cio.remove(path);
    }

    function rename(oldPath, newPath) {
        return cio.rename(oldPath, newPath);
    }

    // ---- streaming File class ----

    class File {
        constructor(handle) {
            this._handle = handle;
        }

        read(n) {
            return cio.fread(this._handle, n);
        }

        write(data) {
            return cio.fwrite(this._handle, toAb(data));
        }

        seek(offset, whence) {
            return cio.fseek(this._handle, offset, whence !== undefined ? whence : 0);
        }

        tell() {
            return cio.ftell(this._handle);
        }

        close() {
            return cio.fclose(this._handle);
        }
    }

    function open(path, mode) {
        const handle = cio.open(path, mode);
        return new File(handle);
    }

    // ---- async API (Phase C) ----
    // Each _async method delegates to a dedicated ioservice via skynet.call,
    // so the caller's service is never blocked by file I/O. Binary data is
    // base64-encoded because js-seri cannot round-trip ArrayBuffer.
    //
    // These methods may only be called inside a skynet coroutine context
    // (skynet.fork / dispatch / timeout callbacks).

    let ioSvc = 0;   // cached ioservice handle (launched once, lazily)

    async function ensureIoService() {
        if (ioSvc !== 0) return ioSvc;
        ioSvc = skynet.newservice("snjs js/ioservice.js");
        return ioSvc;
    }

    // helper: call ioservice, unpack response, throw on failure
    async function ioCall(...packArgs) {
        const svc = await ensureIoService();
        const resp = await skynet.call(svc, "lua", skynet.pack(...packArgs));
        const vals = skynet.unpack(resp);
        if (!vals[0]) throw new Error(vals[1] || "ioservice error");
        return vals[1];   // may be undefined for void ops
    }

    async function readFileAsync(path) {
        const b64 = await ioCall("read_file", path);
        return crypt.base64Decode(b64);
    }

    async function readTextFileAsync(path) {
        return await ioCall("read_text_file", path);
    }

    async function writeFileAsync(path, data) {
        const b64 = crypt.base64Encode(toAb(data));
        await ioCall("write_file", path, b64);
    }

    async function appendFileAsync(path, data) {
        const b64 = crypt.base64Encode(toAb(data));
        await ioCall("append_file", path, b64);
    }

    async function statAsync(path) {
        const jsonStr = await ioCall("stat", path);
        return jsonStr === null || jsonStr === undefined ? null : JSON.parse(jsonStr);
    }

    async function readdirAsync(path) {
        const jsonStr = await ioCall("readdir", path);
        return JSON.parse(jsonStr);
    }

    async function mkdirAsync(path, recursive) {
        await ioCall("mkdir", path, !!recursive);
    }

    async function removeAsync(path) {
        await ioCall("remove", path);
    }

    async function renameAsync(oldPath, newPath) {
        await ioCall("rename", oldPath, newPath);
    }

    const fsx = {
        readFile,
        readTextFile,
        writeFile,
        appendFile,
        exists,
        stat,
        readdir,
        mkdir,
        remove,
        rename,
        open,
        File,
        // async API (Phase C)
        readFileAsync,
        readTextFileAsync,
        writeFileAsync,
        appendFileAsync,
        statAsync,
        readdirAsync,
        mkdirAsync,
        removeAsync,
        renameAsync,
    };
    globalThis.io = fsx;
    if (typeof module !== "undefined" && module.exports) {
        module.exports = fsx;
    }
})();
