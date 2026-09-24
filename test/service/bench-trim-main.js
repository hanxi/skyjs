// Memory-attribution trim driver: runs ONE bench case per dedicated node so
// its RSS peak can be attributed cleanly (case name comes from snjsParam,
// see test/config-bench-*.json bootstrap args). A driver service kicks "run"
// 300ms after start, when snjsParam is already set. Case set mirrors
// bench-suite-main.js; keep the two in lockstep when bench cases change.
skynet.register("main");

const P20 = "ping_" + "m".repeat(15);
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

function caseSeri(name, n, payload) {
    mark(name);
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
        skynet.unpack(skynet.pack(payload));
    }
    unmark(name);
    report(name, n, t0);
}

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
    for (let i = 0; i < n; i++) ps.push(skynet.sleep(10));
    await Promise.all(ps);
    unmark("timer_wake");
    report("timer_wake", n, t0);
}

async function runOne(name) {
    switch (name) {
        case "idle":
            break;
        case "rt_text_c":
            await caseRt("rt_text_c", cEcho, "text", P20, 50000, false);
            break;
        case "rt_text_self":
            await caseRt("rt_text_self", jEcho, "text", P20, 50000, false);
            break;
        case "rt_text_s256":
            await caseRt("rt_text_s256", jEcho, "text", P256, 50000, false);
            break;
        case "rt_text_s4k":
            await caseRt("rt_text_s4k", jEcho, "text", P4K, 50000, false);
            break;
        case "rt_text_s64k":
            await caseRt("rt_text_s64k", jEcho, "text", P64K, 10000, false);
            break;
        case "rt_lua_self":
            await caseRt("rt_lua_self", jEcho, "lua", skynet.pack(TBL10), 20000, true);
            break;
        case "send_self":
            await caseSend(500000);
            break;
        case "conc_self_k1":
            await caseConc(1, 100000, "conc_self_k1");
            break;
        case "conc_self_k8":
            await caseConc(8, 100000, "conc_self_k8");
            break;
        case "sp_t10":
            caseSeri("sp_t10", 100000, TBL10);
            break;
        case "sp_t1000":
            caseSeri("sp_t1000", 5000, ARR1000);
            break;
        case "sp_s64k":
            caseSeri("sp_s64k", 2000, P64K);
            break;
        case "startup_c":
            await caseStartup("startup_c", () => skynetcore.runtime.intCommand("LAUNCH", "echo"));
            break;
        case "startup_self":
            await caseStartup("startup_self",
                () => skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/bench-echo-worker.js"));
            break;
        case "timer_wake":
            await caseTimer(50000);
            break;
        default:
            throw new Error("unknown case " + name);
    }
    skynetcore.runtime.error("BENCH case=mem_trim n=0 mps=0 js_mem=" + skynet.memStat());
    skynetcore.runtime.error("BENCH_TRIM_DONE");
}

skynet.start(() => {
    skynetcore.runtime.intCommand("LAUNCH", "driver .main 300 run x");
    skynet.dispatch("text", (msg) => {
        if (msg !== "run") return "OK";
        runOne(globalThis.snjsParam).catch(e => {
            skynetcore.runtime.error("BENCH_TRIM_FAIL: " + (e && (e.message || e)));
        });
        return undefined;
    });
});
