// Acceptance (JS<->JS variant): cross-node call over skyclusterd, no lua node.
// Same as cluster-a-main.js minus the JS2LUA block, which needs the stock
// lua node on :2530 -- use config-cluster-a.json for that manual scenario.
const cluster = require("../../js/builtins/skyjs/cluster.js");

skynet.register("main");
skynet.newservice("skyclusterd");
cluster.init();
cluster.register("main");
cluster.setNodes({ node2: "127.0.0.1:2529" });
cluster.open(2528);
cluster.register("svc1");
skynetcore.runtime.intCommand("LAUNCH", "driver .main 300 start 0");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg !== "start") return "OK";
        try {
            const r2 = await cluster.call("node2", "svc2", "hello", 41);
            skynetcore.runtime.error("CLUSTER RESULT: " + JSON.stringify(r2.map(v => v instanceof Map ? [...v.entries()] : v)));
            return "CLUSTER_OK";
        } catch (e) {
            skynetcore.runtime.error("CLUSTER FAIL: " + (e && e.message));
            return "CLUSTER_FAIL:" + (e && e.message);
        }
    });
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        return skynet.pack("svc1:" + vals[0], vals[1] + 1);
    });
});
