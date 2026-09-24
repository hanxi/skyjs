// run-bench.js memory-scaling driver (JS side): launches N idle echo services
// on a dedicated node so the steady-state RSS at that service count can be
// attributed cleanly. The count N comes from snjsParam (see the temp config
// tools/run-bench.js writes: bootstrap "snjs test/service/bench-mem-main.js N").
// snjsParam is injected only after the user script finishes eval, so a driver
// service kicks "run" 300ms after start, mirroring bench-trim-main.js. Case set
// stays in lockstep with test/bench-lua/mem-main.lua.
skynet.register("main");

const P20 = "ping_" + "m".repeat(15);      // 20 bytes, constant payload

async function runScale() {
    const n = parseInt(globalThis.snjsParam, 10) || 0;
    const handles = [];
    for (let i = 0; i < n; i++) {
        handles.push(skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/bench-echo-worker.js"));
    }
    // one RTT each so the service actually loaded (snjs loads lazily)
    for (const h of handles) await skynet.call(h, "text", P20);
    skynetcore.runtime.error("BENCH case=mem_scale n=" + n + " mps=0 js_mem=" + skynet.memStat());
    skynetcore.runtime.error("BENCH_MEM_READY count=" + n);
    // idle on purpose: the harness samples steady-state RSS then kills us
}

skynet.start(() => {
    skynetcore.runtime.intCommand("LAUNCH", "driver .main 300 run x");
    skynet.dispatch("text", (msg) => {
        if (msg !== "run") return "OK";
        runScale().catch(e => {
            skynetcore.runtime.error("BENCH_FAIL: " + (e && (e.message || e)));
        });
        return undefined;
    });
});
