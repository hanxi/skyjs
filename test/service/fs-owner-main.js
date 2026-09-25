"use strict";

// NC2.2 acceptance: `.fs` owner service over binary-frame envelopes, plus
// permission rejection (root escape, quota, read-only).

const testing = require("skyjs/testing");
const fsClient = require("../internal/fs-client.js");
const fsx = require("../internal/fs-core.js");
const permission = require("../internal/permission.js");

const DIR = "build/fs_owner_test";

skynet.timeout(1, async () => {
    if (fsx.exists(DIR)) fsx.remove(DIR);
    fsx.mkdir(DIR, true);

    // ---- large binary round-trip through the owner (no base64) ----
    const payload = new Uint8Array(256 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff;

    await fsClient.configure({ roots: [DIR], maxReadBytes: 1024 * 1024 });
    await fsClient.writeFile(DIR + "/big.bin", payload.buffer);

    const readBack = await fsClient.readFile(DIR + "/big.bin");
    const got = new Uint8Array(readBack);
    testing.equal(got.length, payload.length, "large read length");
    let same = true;
    for (let i = 0; i < payload.length; i++) {
        if (payload[i] !== got[i]) { same = false; break; }
    }
    testing.ok(same, "large binary round-trip is byte-identical");

    // ---- stat / readdir through the owner ----
    const st = await fsClient.stat(DIR + "/big.bin");
    testing.equal(st.size, payload.length, "owner stat size");
    const names = await fsClient.readdir(DIR);
    testing.ok(names.includes("big.bin"), "owner readdir");

    // ---- permission: path escaping the configured root ----
    let escaped = null;
    try { await fsClient.readFile("/etc/passwd"); } catch (err) { escaped = err; }
    testing.equal(escaped && escaped.code, "ERR_PERMISSION", "root escape denied");

    // ---- permission: quota ----
    await fsClient.configure({ roots: [DIR], maxReadBytes: 4 });
    let quota = null;
    try { await fsClient.readFile(DIR + "/big.bin"); } catch (err) { quota = err; }
    testing.equal(quota && quota.code, "ERR_LIMIT_EXCEEDED", "quota denied");

    // ---- permission: read-only ----
    await fsClient.configure({ roots: [DIR], readOnly: true });
    let readOnly = null;
    try { await fsClient.writeFile(DIR + "/nope.bin", new ArrayBuffer(1)); }
    catch (err) { readOnly = err; }
    testing.equal(readOnly && readOnly.code, "ERR_PERMISSION", "read-only denied");

    // ---- pure permission logic ----
    const policy = new permission.Permission({ roots: [DIR] });
    testing.ok(policy.resolvePath(DIR + "/x").endsWith("/x"), "resolve inside root");

    fsx.remove(DIR + "/big.bin");
    fsx.remove(DIR);
    skynetcore.runtime.error("FS_OWNER_OK binary=1 permission=3 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "FS_OWNER:" + msg);
});
