// run-bench.js phase-2 driver, node A (port 2528): caller + echo + orchestrator.
// Boot order is enforced by the harness: node B first (BENCH_CLUSTER_READY),
// then A. A runs the cluster.call cases into B, then asks B (control payload
// "__ctl_run" on @bench) to run the reverse direction, and only then signs
// off. Case names are pair-agnostic (cl_100 / cl_40k); the harness renames
// them per pair (cl_jsjs_*, cl_lualua_*, cl_mixed_*). Lockstep with
// test/bench-lua/cluster-main-a.lua.
const cluster = require("../../js/builtins/skyjs/cluster.js");

skynet.register("main");
skynet.newservice("skyclusterd");
cluster.init();
cluster.register("main");
cluster.setNodes({ b: "127.0.0.1:2529" });
cluster.open(2528);
cluster.register("bench");

const P100 = "x".repeat(100);
const P40K = "x".repeat(40000);      // exercises the multipart split path
const CASES = [
    { name: "cl_100", payload: P100, n: 5000, warm: 200 },
    { name: "cl_40k", payload: P40K, n: 1000, warm: 50 },
    // pipelined: conc concurrent callers keep multiple requests in flight per
    // connection, bypassing the Nagle-bound serial RTT (bench.md 解读 8)
    { name: "cl_pipe", payload: P100, n: 5000, warm: 200, conc: 8 },
];

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

async function runCase(peer, c) {
    if (!c.conc) {
        for (let i = 0; i < c.n; i++) await cluster.call(peer, "@bench", c.payload);
        return;
    }
    const per = Math.floor(c.n / c.conc);
    const jobs = [];
    for (let w = 0; w < c.conc; w++) {
        jobs.push((async () => {
            for (let i = 0; i < per; i++) await cluster.call(peer, "@bench", c.payload);
        })());
    }
    await Promise.all(jobs);
}

async function runDirection(peer) {
    for (const c of CASES) {
        for (let i = 0; i < c.warm; i++) await cluster.call(peer, "@bench", c.payload);
        mark(c.name);
        const t0 = Date.now();
        await runCase(peer, c);
        unmark(c.name);
        report(c.name, c.n, t0);
    }
}

skynet.start(() => {
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        if (vals[0] === "__ctl_run") {
            // ack only after the reverse direction finished, so node A (and
            // then the harness) knows both streams are complete
            return (async () => {
                await runDirection("a");
                skynetcore.runtime.error("BENCH_SUITE_DONE");
                return skynet.pack("ctl-done");
            })();
        }
        return skynet.pack(...vals);
    });
    (async () => {
        skynetcore.runtime.error("BENCH_CLUSTER_READY");
        await runDirection("b");
        await cluster.call("b", "@bench", "__ctl_run");
        skynetcore.runtime.error("BENCH_SUITE_DONE");
    })().catch(e => {
        skynetcore.runtime.error("BENCH_FAIL: " + (e && (e.message || e)));
    });
});
