// run-bench.js phase-1 driver (JS side): runs the core messaging cases and
// prints the machine-parsable bench protocol consumed by tools/run-bench.js:
//   BENCH_BEGIN <case> / BENCH_END <case>  -- coarse wall markers (sanity only)
//   BENCH case=<name> n=<N> mps=<v> ms=<ms> -- THE timing authority
// Timing is in-process Date.now() around each loop: log lines cross the
// logger service asynchronously and lag under CPU saturation, so the
// harness's cross-process hrtime between markers is only a gross check.
// Case set must stay in lockstep with test/bench-lua/main.lua.
skynet.register("main");

const P20 = "ping_" + "m".repeat(15);      // 20 bytes, constant payload
const P256 = "x".repeat(256);
const P4K = "x".repeat(4096);
const P64K = "x".repeat(65536);
const TBL10 = { id: 1, type: 2, hp: 100, mp: 50, x: 3, y: 4, lv: 10, exp: 999, gold: 88, flag: 1 };
const ARR1000 = Array.from({ length: 1000 }, (v, i) => i);
const STARTUP_N = 500;

const cEcho = skynetcore.runtime.intCommand("LAUNCH", "echo");
const jEcho = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/bench-echo-worker.js");

function mark(name) {
    skynetcore.runtime.error("BENCH_BEGIN " + name);
}

function unmark(name) {
    skynetcore.runtime.error("BENCH_END " + name);
}

function report(name, n, t0) {
    const dt = Date.now() - t0;
    const mps = dt > 0 ? Math.round(n * 1000 / dt) : 0;
    skynetcore.runtime.error("BENCH case=" + name + " n=" + n + " mps=" + mps + " ms=" + dt);
}

// round trips; decode=true additionally unpacks the lua-protocol response,
// matching the auto-unpack skynet.lua does for the Lua caller
async function caseRt(name, target, proto, payload, n, decode) {
    mark(name);
    const t0 = Date.now();
    if (decode) {
        for (let i = 0; i < n; i++) skynet.unpack(await skynet.call(target, proto, payload));
    } else {
        for (let i = 0; i < n; i++) await skynet.call(target, proto, payload);
    }
    unmark(name);
    report(name, n, t0);
}

// K concurrent callers, n round trips total
async function caseConc(k, n, name) {
    mark(name);
    const t0 = Date.now();
    const per = Math.floor(n / k);
    const jobs = [];
    for (let c = 0; c < k; c++) {
        jobs.push((async () => {
            for (let i = 0; i < per; i++) await skynet.call(jEcho, "text", P20);
        })());
    }
    await Promise.all(jobs);
    unmark(name);
    report(name, n, t0);
}

// pure in-process pack/unpack, no kernel messaging involved
function caseSeri(name, n, payload) {
    mark(name);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
        skynet.unpack(skynet.pack(payload));
    }
    unmark(name);
    report(name, n, t0);
}

// service creation through the framework's own path + one round trip each so
// the service actually processed its first message (snlua loads lazily)
async function caseStartup(name, launch) {
    mark(name);
    const t0 = Date.now();
    const handles = [];
    for (let i = 0; i < STARTUP_N; i++) handles.push(launch());
    for (const h of handles) await skynet.call(h, "text", P20);
    unmark(name);
    report(name, STARTUP_N, t0);
}

async function caseSend(n) {
    // fire-and-forget: skynet.send is session 0, echo ignores those and only
    // the kernel dispatch cost is measured; the trailing call is the FIFO
    // drain barrier (same service queue, so it runs after all sends)
    mark("send_self");
    const t0 = Date.now();
    for (let i = 0; i < n; i++) skynetcore.runtime.send(jEcho, 0, P20, 0);
    await skynet.call(jEcho, "text", P20);
    unmark("send_self");
    report("send_self", n, t0);
}

async function caseTimer(n) {
    mark("timer_wake");
    const t0 = Date.now();
    const ps = [];
    for (let i = 0; i < n; i++) ps.push(skynet.sleep(10));   // 10ms = 1cs
    await Promise.all(ps);
    unmark("timer_wake");
    report("timer_wake", n, t0);
}

async function runAll() {
    // warmup (untimed): both targets, both protocols, a few pack ops
    for (let i = 0; i < 300; i++) await skynet.call(cEcho, "text", P20);
    for (let i = 0; i < 300; i++) await skynet.call(jEcho, "text", P20);
    for (let i = 0; i < 100; i++) skynet.unpack(skynet.pack(TBL10));

    await caseRt("rt_text_c", cEcho, "text", P20, 50000, false);
    await caseRt("rt_text_self", jEcho, "text", P20, 50000, false);
    await caseRt("rt_text_s256", jEcho, "text", P256, 50000, false);
    await caseRt("rt_text_s4k", jEcho, "text", P4K, 50000, false);
    await caseRt("rt_text_s64k", jEcho, "text", P64K, 10000, false);
    await caseRt("rt_lua_self", jEcho, "lua", skynet.pack(TBL10), 20000, true);

    await caseSend(500000);
    await caseConc(1, 100000, "conc_self_k1");
    await caseConc(8, 100000, "conc_self_k8");

    caseSeri("sp_t10", 100000, TBL10);
    caseSeri("sp_t1000", 5000, ARR1000);
    caseSeri("sp_s64k", 2000, P64K);

    await caseStartup("startup_c", () => skynetcore.runtime.intCommand("LAUNCH", "echo"));
    await caseStartup("startup_self",
        () => skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/bench-echo-worker.js"));

    await caseTimer(50000);

    // footprint note; process RSS is sampled by the harness itself
    mark("mem_report");
    unmark("mem_report");
    skynetcore.runtime.error("BENCH case=mem_report n=0 mps=0 js_mem=" + skynet.memStat());
    skynetcore.runtime.error("BENCH_SUITE_DONE");
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => (msg === "run" ? runAll() : "OK"));
    runAll().catch(e => {
        skynetcore.runtime.error("BENCH_FAIL: " + (e && (e.message || e)));
    });
});
