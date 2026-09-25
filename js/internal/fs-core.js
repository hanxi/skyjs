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
        return skynetcore.seri.str(cio.readFile(path));
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
        return normalizeStat(cio.stat(path));
    }

    function lstat(path) {
        return normalizeStat(cio.lstat(path));
    }

    function fstat(fd) {
        return normalizeStat(cio.fstat(fd));
    }

    function statvfs(path) {
        return cio.statvfs(path);
    }

    function realpath(path) {
        return cio.realpath(path);
    }

    function chmod(path, mode) {
        return cio.chmod(path, mode);
    }

    function chown(path, uid, gid) {
        return cio.chown(path, uid, gid);
    }

    function utimes(path, atime, mtime) {
        return cio.utimes(path, atime, mtime);
    }

    function symlink(target, path) {
        return cio.symlink(target, path);
    }

    function readlink(path) {
        return cio.readlink(path);
    }

    function mkdtemp(prefix) {
        return cio.mkdtemp(prefix);
    }

    // The C primitive already returns the legacy fsx shape ({ size, mtime,
    // isDir, isFile, mode }); the Node `fs` facade wraps it in fs.Stats.
    function normalizeStat(raw) {
        if (raw === null || raw === undefined) {
            const err = new Error("ENOENT: no such file or directory");
            err.code = "ENOENT";
            err.errno = -2;
            err.syscall = "stat";
            err.detail = { skyjsCode: "ERR_NOT_FOUND", errno: -2, syscall: "stat" };
            throw err;
        }
        return raw;
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

        truncate(len) {
            return cio.ftruncate(this._handle, len);
        }

        sync() {
            return cio.fsync(this._handle);
        }

        datasync() {
            return cio.fdatasync(this._handle);
        }

        chmod(mode) {
            return cio.fchmod(this._handle, mode);
        }

        utimes(atime, mtime) {
            return cio.futimes(this._handle, atime, mtime);
        }
    }

    function open(path, mode) {
        const handle = cio.open(path, mode);
        return new File(handle);
    }

    // ---- async API ----
    // Delegates to the `.fs` owner service over binary-frame envelopes; the
    // caller's service is never blocked by file I/O, and large payloads stay
    // binary (no base64).
    const fsClient = require("./fs-client.js");

    async function readFileAsync(path) {
        return fsClient.readFile(path);
    }

    async function readTextFileAsync(path) {
        return new TextDecoder().decode(new Uint8Array(await fsClient.readFile(path)));
    }

    async function writeFileAsync(path, data) {
        await fsClient.writeFile(path, toAb(data));
    }

    async function appendFileAsync(path, data) {
        const existing = exists(path) ? readFile(path) : new ArrayBuffer(0);
        const current = new Uint8Array(existing);
        const extra = new Uint8Array(toAb(data));
        const merged = new Uint8Array(current.length + extra.length);
        merged.set(current, 0);
        merged.set(extra, current.length);
        await fsClient.writeFile(path, merged.buffer);
    }

    async function statAsync(path) {
        return fsClient.stat(path);
    }

    async function readdirAsync(path) {
        return fsClient.readdir(path);
    }

    async function mkdirAsync(path, recursive) {
        mkdir(path, recursive);
    }

    async function removeAsync(path) {
        remove(path);
    }

    async function renameAsync(oldPath, newPath) {
        rename(oldPath, newPath);
    }

    const fsx = {
        readFile,
        readTextFile,
        writeFile,
        appendFile,
        exists,
        stat,
        lstat,
        fstat,
        statvfs,
        realpath,
        chmod,
        chown,
        utimes,
        symlink,
        readlink,
        mkdtemp,
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
    module.exports = fsx;
})();
