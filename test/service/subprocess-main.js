"use strict";

// NC3 acceptance: spawn/exec/execFile over the `.subprocess` owner, plus the
// skyjs/subprocess named-process API, quota and kill semantics.

const testing = require("skyjs/testing");
const cp = require("child_process");
const subprocess = require("skyjs/subprocess");

skynet.timeout(1, async () => {
    // ---- spawn + stdout streaming ----
    const child = cp.spawn("/bin/echo", ["hello", "subprocess"]);
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c.toString()));
    const status = await child.wait();
    testing.equal(status.code, 0, "spawn exit code");
    testing.equal(chunks.join(""), "hello subprocess\n", "spawn stdout");

    // ---- exec collects output ----
    const result = await cp.exec("echo via-exec");
    testing.equal(result.code, 0, "exec code");
    testing.equal(result.stdout, "via-exec\n", "exec stdout");

    // ---- execFile ----
    const fileResult = await cp.execFile("/bin/echo", ["via-execfile"]);
    testing.equal(fileResult.stdout, "via-execfile\n", "execFile stdout");

    // ---- exit code propagation ----
    const failing = cp.spawn("/bin/sh", ["-c", "exit 7"]);
    const failStatus = await failing.wait();
    testing.equal(failStatus.code, 7, "exit code propagated");

    // ---- stdin pipe ----
    const cat = cp.spawn("/bin/cat", []);
    const catOut = [];
    cat.stdout.on("data", (c) => catOut.push(c.toString()));
    cat.stdin.end("piped-input");
    await cat.wait();
    testing.equal(catOut.join(""), "piped-input", "stdin pipe");

    // ---- kill ----
    const sleeper = cp.spawn("/bin/sleep", ["30"]);
    await sleeper.ready;
    sleeper.kill();
    const killStatus = await sleeper.wait();
    testing.ok(killStatus.code !== 0 || killStatus.signal !== null, "killed process reported");

    // ---- skyjs/subprocess named API ----
    await subprocess.start("worker", "/bin/sleep", ["30"]);
    testing.ok(await subprocess.isRunning("worker"), "named process running");
    const running = await subprocess.list();
    testing.ok(running.some((p) => p.name === "worker"), "named process listed");
    await subprocess.stop("worker");
    testing.ok(!(await subprocess.isRunning("worker")), "named process stopped");

    // ---- error: program not found ----
    let missing = null;
    try { await cp.exec("definitely-not-a-real-program-xyz"); }
    catch (err) { missing = err; }
    testing.ok(missing !== null, "missing program errors");

    skynetcore.runtime.error("SUBPROCESS_OK spawn=1 exec=1 execfile=1 stdin=1 kill=1 named=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "SUBPROCESS:" + msg);
});
