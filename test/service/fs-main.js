"use strict";

// NC2.4 acceptance: Node `fs` in all three forms (callback / sync / Promise)
// sharing one kernel with `skyjs/fsx`.

const testing = require("skyjs/testing");
const fs = require("fs");
const fsp = require("fs/promises");
const fsx = require("skyjs/fsx");

const DIR = "build/fs_test";

function cleanup() {
    if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
}

skynet.timeout(1, async () => {
    cleanup();
    fs.mkdirSync(DIR, { recursive: true });
    fs.mkdirSync(DIR + "/sub", { recursive: true });

    // ---- sync ----
    fs.writeFileSync(DIR + "/sync.txt", "sync-data");
    testing.equal(fs.readFileSync(DIR + "/sync.txt", "utf8"), "sync-data", "sync round-trip");
    testing.equal(fs.readFileSync(DIR + "/sync.txt").toString(), "sync-data", "sync buffer");
    fs.appendFileSync(DIR + "/sync.txt", "+more");
    testing.equal(fs.readFileSync(DIR + "/sync.txt", "utf8"), "sync-data+more", "sync append");

    const st = fs.statSync(DIR + "/sync.txt");
    testing.ok(st.isFile() && !st.isDirectory(), "statSync isFile");
    testing.equal(st.size, 14, "statSync size");
    testing.ok(st.mtime instanceof Date, "statSync mtime Date");

    testing.ok(fs.existsSync(DIR), "existsSync true");
    testing.ok(!fs.existsSync(DIR + "/nope"), "existsSync false");

    // ---- callback ----
    await new Promise((resolve, reject) => {
        fs.writeFile(DIR + "/cb.txt", "cb-data", (err) => {
            if (err) { reject(err); return; }
            fs.readFile(DIR + "/cb.txt", "utf8", (readErr, data) => {
                if (readErr) { reject(readErr); return; }
                try { testing.equal(data, "cb-data", "callback round-trip"); } catch (e) { reject(e); return; }
                resolve();
            });
        });
    });
    await new Promise((resolve, reject) => {
        fs.readdir(DIR, (err, names) => {
            if (err) { reject(err); return; }
            try { testing.ok(names.includes("sync.txt"), "callback readdir"); } catch (e) { reject(e); return; }
            resolve();
        });
    });

    // ---- promise ----
    await fsp.writeFile(DIR + "/p.txt", "p-data");
    testing.equal(await fsp.readFile(DIR + "/p.txt", "utf8"), "p-data", "promise round-trip");
    testing.ok((await fsp.stat(DIR + "/p.txt")).isFile(), "promise stat");
    const pFiles = await fsp.readdir(DIR);
    testing.ok(pFiles.includes("p.txt"), "promise readdir");
    await fsp.rm(DIR + "/p.txt");
    testing.ok(!fsp.constants === false && fs.constants.F_OK === 0, "constants");

    // ---- extended primitives ----
    const real = fs.realpathSync(DIR);
    testing.ok(real.endsWith("fs_test"), "realpathSync");
    fs.symlinkSync("sync.txt", DIR + "/link.txt");
    testing.equal(fs.readlinkSync(DIR + "/link.txt"), "sync.txt", "readlinkSync");
    testing.ok(fs.lstatSync(DIR + "/link.txt").isSymbolicLink(), "lstat symlink");
    fs.chmodSync(DIR + "/sync.txt", 0o600);
    testing.equal(fs.statSync(DIR + "/sync.txt").mode & 0o777, 0o600, "chmodSync");
    const tmp = fs.mkdtempSync(DIR + "/tmp-");
    testing.ok(fs.existsSync(tmp), "mkdtempSync");
    fs.rmSync(tmp, { recursive: true, force: true });
    testing.ok(typeof fs.statfsSync(DIR).bsize === "number", "statfsSync");

    // ---- streams ----
    const chunks = [];
    await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(DIR + "/sync.txt");
        rs.on("data", (c) => chunks.push(c.toString()));
        rs.on("end", resolve);
        rs.on("error", reject);
    }).then(() => {
        testing.equal(chunks.join(""), "sync-data+more", "createReadStream");
    });
    await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(DIR + "/stream.txt");
        ws.on("finish", resolve);
        ws.on("error", reject);
        ws.write("a");
        ws.end("b");
    });
    testing.equal(fs.readFileSync(DIR + "/stream.txt", "utf8"), "ab", "createWriteStream");

    // ---- watch reports unavailability explicitly ----
    let watchErr = null;
    try { fs.watch(DIR, () => {}); } catch (err) { watchErr = err; }
    testing.equal(watchErr && watchErr.code, "ERR_UNSUPPORTED_PLATFORM", "watch unsupported explicit");

    // ---- fs-error shape ----
    let missing = null;
    try { fs.readFileSync(DIR + "/definitely-missing"); } catch (err) { missing = err; }
    testing.equal(missing.code, "ENOENT", "missing file errno code");
    testing.equal(missing.errno, -2, "missing file errno value");
    testing.equal(missing.syscall, "open", "missing file syscall");
    testing.equal(missing.detail.skyjsCode, "ERR_NOT_FOUND", "missing file skyjs class");

    // ---- fsx shares the kernel ----
    fsx.writeFile(DIR + "/fsx.txt", "fsx-data");
    testing.equal(fs.readFileSync(DIR + "/fsx.txt", "utf8"), "fsx-data", "fsx shared kernel");

    cleanup();
    skynetcore.runtime.error("FS_OK sync=1 callback=1 promise=1 stream=1 errors=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "FS:" + msg);
});
