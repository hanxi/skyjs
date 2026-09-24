// Task 7: message throughput benchmark (single node, serial round trips).
// Compares JS->C echo vs JS->JS echo; timing via skynetcore.runtime.now (centiseconds).
const cEcho = skynetcore.runtime.intCommand("LAUNCH", "echo");
const jEcho = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/bench-smoke-worker.js");
skynet.register("main");
skynetcore.runtime.intCommand("LAUNCH", "driver .main 300 bench 0");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg !== "bench") return "OK";
        const N = 20000;
        for (let i = 0; i < 100; i++) await skynet.call(cEcho, "text", "w");
        let t0 = skynetcore.runtime.now();
        for (let i = 0; i < N; i++) await skynet.call(cEcho, "text", "m" + i);
        let t1 = skynetcore.runtime.now();
        for (let i = 0; i < 100; i++) await skynet.call(jEcho, "text", "w");
        let t2 = skynetcore.runtime.now();
        for (let i = 0; i < N; i++) await skynet.call(jEcho, "text", "m" + i);
        let t3 = skynetcore.runtime.now();
        const r = "BENCH N=" + N
            + " c_echo=" + ((N * 100) / (t1 - t0)).toFixed(0) + " msg/s"
            + " j_echo=" + ((N * 100) / (t3 - t2)).toFixed(0) + " msg/s"
            + " js_mem=" + skynet.memStat() + "B";
        skynetcore.runtime.error(r);
        return r;
    });
});
