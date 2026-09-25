"use strict";
// tools/run-tests.js -- zero-dependency acceptance runner (replaces manual
// log-watching, see README acceptance matrix).
//
// Model: every scenario boots ./skyjs with a test config and watches stdout+
// stderr line by line. A scenario PASSES when ALL "must" markers appear and
// NO "never" marker ever does; the process is killed as soon as it passes, so
// healthy runs finish in ~1s instead of waiting out a fixed sleep.
//
// Design points learned from real regressions:
//   - "never" includes "Maximum call stack size exceeded" and "KILL self":
//     the cross-thread stack_top bug only showed up ~1 run in 5, so use
//     --repeat N to sweep flaky failures (default 2).
//   - cluster: node B must log "listen port 2529 -> id <positive>" before
//     node A starts; a negative id means a stale process held the port and
//     the acceptance would look green while testing the wrong binary.
//   - crash detection: a child dying by signal (segfault etc.) fails its
//     scenario even if markers matched.
//
// Usage: node tools/run-tests.js [--repeat N] [--filter substr] [--timeout ms]

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const ROOT = process.cwd();
const BIN = path.join(ROOT, "skyjs");
const SERI_TOOL = path.join(ROOT, "test", "seri-tool");
const SERI_REF = path.join(ROOT, "build", "seri-ref.bin");

const DEFAULT_TIMEOUT_MS = 15000;

// markers that must never appear in ANY scenario (regression sentinels)
const NEVER = [
    "Maximum call stack size exceeded",
    "snjs seri init error",
    "snjs loader error",
    "snjs load error",
    "snjs wrap error",
    "KILL self",
    "SERI FAIL",
    "CLUSTER FAIL",
    "GATE FAIL",
    "CRYPT FAIL",
    "HTTP FAIL",
    "WS FAIL",
    "TLS FAIL",
    "IO FAIL",
    "dispatch rejected",
];

// the acceptance suite; one entry per README acceptance-matrix row
const SUITE = [
    { name: "core", config: "test/config-core.json",
        must: ["echo service started", "LAUNCH echo"] },
    { name: "module_system", config: "test/config-module-system.json",
        must: ["MODULE_SYSTEM_OK cache=1 cycles=a/b locals=true file=true"] },
    { name: "features", config: "test/config-features.json",
        mustRe: [/FEATURES_OK version=0\.1\.0 platform=(?:darwin|linux) arch=(?:arm64|x64)/] },
    { name: "skynetcore_groups", config: "test/config-skynetcore-groups.json",
        must: ["SKYNETCORE_GROUPS_OK fs=1 net=1 seri=1 features=1"] },
    { name: "timers", config: "test/config-timers.json",
        mustRe: [/TIMERS_OK order=[^ ]+/] },
    { name: "process_exit", config: "test/config-process-exit.json",
        must: ["PROCESS_EXIT_START"], expectExit: 3 },
    { name: "process_natural", config: "test/config-process-natural.json",
        must: ["PROCESS_NATURAL_START"], expectExit: 7 },
    { name: "globals", config: "test/config-globals.json",
        must: ["GLOBALS_OK events=1 buffer=1 abort=1"] },
    { name: "buffer_entry", config: "test/config-buffer-entry.json",
        must: ["BUFFER_ENTRY_OK buffer=1 blob=1 file=1"] },
    { name: "binary_frame", config: "test/config-binary-frame.json",
        mustRe: [/BINARY_FRAME_OK bytes=196608 checks=\d+/] },
    { name: "stream", config: "test/config-stream.json",
        mustRe: [/STREAM_OK node=1 kernel=1 iterator=1 checks=\d+/] },
    { name: "node_modules", config: "test/config-node-modules.json",
        mustRe: [/NODE_MODULES_OK bare=1 scoped=1 subpath=1 main=1 json=1 builtin=1 checks=\d+/] },
    { name: "echo", config: "test/config-echo.json",
        must: ["DRIVER RESP: JS_ECHO:hello_from_js"] },
    { name: "async", config: "test/config-async.json",
        must: ["ASYNC RESULT: R1=ping|R2=A(B(go->B))|REENTRY=A(B1(C(D(B2(left))))),A(B1(C(D(B2(right)))))|DUAL=A(BDUAL(X(pair-first),X(pair-second)))|CONC=c0,c1,c2,c3,c4,c5,c6,c7,c8,c9|ERR=true"] },
    { name: "deadloop", config: "test/config-deadloop.json", timeoutMs: 20000,
        allow: ["KILL self"],
        must: ["DRIVER ERROR from", "snjs pending job loop interrupted"] },
    { name: "oom", config: "test/config-oom.json",
        must: ["DRIVER RESP: OOM_CAUGHT:InternalError:out of memory"] },
    { name: "console", config: "test/config-console.json",
        must: ["FMT [s] [7] [3] [1.25] [{\"k\":1}] [[2, 3]] [%]",
               "FMT missing [1] trailing extra", "no such label 'NOPE'",
               "CONSOLE_OK"],
        mustRe: [/T: \d+ms/] },
    { name: "socket", config: "test/config-socket.json",
        must: ["SOCKTEST ALL_ECHO_OK", "SOCKTEST conn 3 closed"] },
    // gate/redirect + C netpack frame buffer + per-connection binary: a JS
    // client sends framed (incl. binary/coalesced/split) packets through the
    // gate, watchdog binds an agent, agent echoes each packet's raw payload
    { name: "gate", config: "test/config-gate.json",
        must: ["WATCHDOG gate ready on port 18855", "GATE_OK 2 clients x 5017 bytes"] },
    { name: "seri", config: "test/config-seri.json", special: runSeri },
    // JS<->JS variant: the original config-cluster-a.json also queries a stock
    // lua node on :2530, which only exists in the manual interop scenario
    { name: "cluster", config: "test/config-cluster.json", special: runCluster },
    // reconnect semantics: peer down -> calls fail immediately (no hang, no
    // background retry); peer up -> the next call reconnects on demand
    { name: "cluster_fail", config: "test/config-cluster-fail.json", special: runClusterFail },
    { name: "crypt", config: "test/config-crypt.json",
        must: ["CRYPT ALL OK"] },
    { name: "io", config: "test/config-io.json", timeoutMs: 20000,
        must: ["IO ALL OK"] },
    { name: "http", config: "test/config-http.json", timeoutMs: 20000,
        must: ["HTTP ALL OK"] },
    { name: "ws", config: "test/config-ws.json", timeoutMs: 20000,
        must: ["WS ALL OK"] },
    { name: "tls", config: "test/config-tls.json", timeoutMs: 20000,
        must: ["TLS ALL OK"] },
    { name: "bench", config: "test/config-bench.json", timeoutMs: 60000,
        mustRe: [/BENCH N=20000 c_echo=\d+ msg\/s j_echo=\d+ msg\/s/] },
];

/* ------------------------------------------------------------------ utils */

function log(msg) {
    process.stdout.write(msg + "\n");
}

function killTree(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const t = setTimeout(() => child.kill("SIGKILL"), 500);
    t.unref();
}

// watch one child's stdout+stderr; on_line gets every line; resolves on exit
function watchLines(child, onLine) {
    const streams = [child.stdout, child.stderr];
    const done = new Promise((resolve) => {
        let open = streams.length;
        for (const st of streams) {
            readline.createInterface({ input: st }).on("line", onLine);
            st.on("end", () => { if (--open === 0) resolve(); });
        }
        child.on("exit", () => resolve());
    });
    return done;
}

/* --------------------------------------------------------- scenario runner */

// watch an already-running child for must/never markers; returns { ok, why, log }
function watchMarkers(child, must, never, timeoutMs, mustRe, expectExit) {
    return new Promise((resolve) => {
        const pending = new Set(must);
        const lines = [];
        let bad = null;
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (bad) return resolve({ ok: false, why: bad, log: lines });
            if (child.signalCode === "SIGSEGV" || child.signalCode === "SIGBUS" ||
                child.signalCode === "SIGABRT") {
                return resolve({ ok: false, why: "crashed: " + child.signalCode, log: lines });
            }
            if (pending.size > 0) {
                return resolve({ ok: false, why: "exit before markers; missing: [" +
                    [...pending].join("; ") + "]", log: lines });
            }
            if (expectExit !== undefined && child.exitCode !== expectExit) {
                return resolve({ ok: false, why: "expected exit code " + expectExit +
                    ", got " + child.exitCode + " (signal " + child.signalCode + ")",
                    log: lines });
            }
            resolve({ ok: true, why: "", log: lines });
        };

        const timer = setTimeout(() => {
            bad = "timeout after " + timeoutMs + "ms; missing: [" +
                [...pending].join("; ") + "]";
            killTree(child);
            finish();
        }, timeoutMs);

        watchLines(child, (line) => {
            if (lines.length < 400) lines.push(line);
            if (bad) return;
            for (const n of never) {
                if (line.includes(n)) {
                    bad = "forbidden marker: " + n;
                    killTree(child);
                    finish();
                    return;
                }
            }
            for (const m of [...pending]) {
                if (line.includes(m)) pending.delete(m);
            }
            for (const re of mustRe) {
                if (re.test(line)) pending.delete(String(re));
            }
            if (pending.size === 0 && expectExit === undefined) {
                killTree(child);
                finish();
            }
        });
        child.on("close", finish);
    });
}

// launch one ./skyjs <config> and wait for markers; returns { ok, why, log }
function runConfig(cfg, must, never, timeoutMs, mustRe, expectExit) {
    const child = spawn(BIN, [cfg], { cwd: ROOT });
    return watchMarkers(child, must, never, timeoutMs, mustRe, expectExit);
}

/* ---------------------------------------------------- special: lua-seri */

async function runSeri(cfg, never, timeoutMs) {
    fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
    const gen = spawnSync(SERI_TOOL, ["gen", SERI_REF], { cwd: ROOT, encoding: "utf8" });
    if (gen.status !== 0) {
        return { ok: false, why: "seri-tool gen failed: " + (gen.stderr || gen.status) };
    }
    const r = await runConfig(cfg,
        ["SERI RESULT: ALL_OK", "DRIVER RESP: SERI_ALL_OK"], never, timeoutMs, []);
    if (!r.ok) return r;

    // the JS-packed file must survive the ORIGINAL unpacker: byte-level
    // compatibility is proven when the stock lua-seri can dump it back
    // (seri-main.js writes to this hardcoded path)
    const dump = spawnSync(SERI_TOOL, ["dump", "build/seri-js.bin"],
        { cwd: ROOT, encoding: "utf8" });
    if (dump.status !== 0) {
        return { ok: false, why: "seri-tool dump crashed (status " + dump.status + ")" };
    }
    const want = ["[1] str:two", "[3] table:", "str:k", "int:5", "str:pi", "real:3.14", "[4] table:"];
    const missing = want.filter((w) => !dump.stdout.includes(w));
    if (missing.length > 0) {
        return { ok: false, why: "dump missing: [" + missing.join("; ") + "]" };
    }
    return { ok: true, why: "" };
}

/* --------------------------------------------------- special: cluster x2 */

function freeClusterPorts() {
    // stale listeners from a previous run make acceptance look green while
    // testing the wrong binary; best-effort cleanup, the id check below
    // catches anything that survives
    const r = spawnSync("sh", ["-c",
        "lsof -nP -tiTCP:2528 -tiTCP:2529 -tiTCP:2530 -sTCP:LISTEN | xargs kill"],
        { cwd: ROOT });
    void r;
}

async function runCluster(cfg, never, timeoutMs) {
    freeClusterPorts();
    const nodeB = path.join(ROOT, "test", "config-cluster-b.json");
    const b = spawn(BIN, [nodeB], { cwd: ROOT });
    const bReady = new Promise((resolve) => {
        watchLines(b, (line) => {
            // id must be positive: "id -1" means the port was taken
            if (/listen port 2529 -> id [1-9]/.test(line)) resolve(true);
        });
        setTimeout(() => resolve(false), timeoutMs);
    });
    const ready = await bReady;
    if (!ready) {
        killTree(b);
        return { ok: false, why: "node B never logged a positive listen id" };
    }

    const r = await runConfig(cfg,
        ["CLUSTER RESULT: [\"svc2:hello\",42]", "DRIVER RESP: CLUSTER_OK"],
        never, timeoutMs, []);
    killTree(b);
    return r;
}

/* ------------------------------------------- special: reconnect semantics */

// Two phases over ONE node A process (a second watch after A dies would
// never see its already-emitted 'end'/'close' events, so one watch_lines
// state machine covers both phases):
//   phase 1: node2 down -> two calls 500ms apart are rejected immediately
//   (a background-retry regression hangs here and times out);
//   phase 2: node B boots mid-stream and A's next call reconnects on demand.
async function runClusterFail(cfg, never, timeoutMs) {
    freeClusterPorts();
    return new Promise((resolve) => {
        const a = spawn(BIN, [cfg], { cwd: ROOT });
        const bReadyRe = /listen port 2529 -> id [1-9]/;
        const pending = new Set(["CLUSTER DOWN OK1", "CLUSTER DOWN OK2",
            "CLUSTER RESULT: [\"svc2:hello\",42]", "CLUSTER BIG OK: 40005"]);
        const lines = [];
        let b = null;
        let bUp = false;
        let bad = null;
        const cleanup = () => {
            killTree(a);
            if (b) killTree(b);
        };
        const timer = setTimeout(() => {
            bad = "timeout after " + timeoutMs + "ms; missing: [" +
                [...pending].join("; ") + "]";
            cleanup();
        }, timeoutMs);

        watchLines(a, (line) => {
            if (lines.length < 400) lines.push(line);
            if (bad) return;
            for (const n of never) {
                if (line.includes(n)) {
                    bad = "forbidden marker: " + n;
                    cleanup();
                    return;
                }
            }
            for (const m of [...pending]) {
                if (line.includes(m)) pending.delete(m);
            }
            if (!pending.has("CLUSTER DOWN OK2") && b === null) {
                // phase 1 complete: boot node B; A keeps calling and will
                // reconnect on demand once B listens
                b = spawn(BIN, [path.join(ROOT, "test", "config-cluster-b.json")],
                    { cwd: ROOT });
                watchLines(b, (bline) => {
                    // id must be positive: "id -1" means the port was taken
                    if (bReadyRe.test(bline)) bUp = true;
                });
            }
            if (pending.size === 0) {
                clearTimeout(timer);
                cleanup();
            }
        }).then(() => {
            clearTimeout(timer);
            if (bad) return resolve({ ok: false, why: bad, log: lines });
            if (a.signalCode === "SIGSEGV" || a.signalCode === "SIGBUS" ||
                a.signalCode === "SIGABRT") {
                return resolve({ ok: false, why: "crashed: " + a.signalCode, log: lines });
            }
            if (pending.size > 0) {
                return resolve({ ok: false, why: "exit before markers; missing: [" +
                    [...pending].join("; ") + "]" +
                    (b && !bUp ? " (node B never ready)" : ""), log: lines });
            }
            resolve({ ok: true, why: "", log: lines });
        });
    });
}

/* ------------------------------------------------------------------ main */

function parseArgs(argv) {
    const opts = { repeat: 2, filter: "", timeoutMs: DEFAULT_TIMEOUT_MS };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--repeat") opts.repeat = parseInt(argv[++i], 10);
        else if (argv[i] === "--filter") opts.filter = argv[++i];
        else if (argv[i] === "--timeout") opts.timeoutMs = parseInt(argv[++i], 10);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(BIN)) {
        log("skyjs binary not found: " + BIN + " (run make first)");
        process.exit(1);
    }
    const cases = SUITE.filter((c) => c.name.includes(opts.filter));
    if (cases.length === 0) {
        log("no scenario matches filter: " + opts.filter);
        process.exit(1);
    }

    let failed = 0;
    for (let round = 1; round <= opts.repeat && failed === 0; round++) {
        log("== round " + round + "/" + opts.repeat + " ==");
        for (const c of cases) {
            const t0 = Date.now();
            const allowed = new Set(c.allow || []);
            const never = NEVER.filter((marker) => !allowed.has(marker));
            const timeoutMs = c.timeoutMs || opts.timeoutMs;
            const r = c.special
                ? await c.special(c.config, never, timeoutMs)
                : await runConfig(c.config, c.must || [], never, timeoutMs, c.mustRe || [],
                    c.expectExit);
            const ms = ((Date.now() - t0) / 1000).toFixed(1);
            const tag = r.ok ? "PASS" : "FAIL";
            log(tag.padEnd(5) + c.name.padEnd(12) + ms.padStart(6) + "s" +
                (r.ok ? "" : "  -- " + r.why));
            if (!r.ok && r.log) {
                for (const l of r.log.slice(-25)) log("      | " + l);
            }
            if (!r.ok) failed++;
        }
    }

    log("== summary: " + (failed === 0 ? "ALL PASS" : failed + " FAILURE(S)") +
        " (" + opts.repeat + " round" + (opts.repeat > 1 ? "s" : "") + ") ==");
    process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
    main();
}

// reusable for sibling tools (tools/run-interop.js): run_tests only boots
// its suite when it IS the main module
module.exports = { ROOT, BIN, NEVER, watchLines, watchMarkers, killTree, freeClusterPorts,
    runConfig };
