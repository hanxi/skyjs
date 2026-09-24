// Task 6 acceptance, node A (port 2528): launches skyclusterd, opens the
// listener, registers "svc1", then on "start" makes a cross-node call to
// node B's @svc2 and reports the result.
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
            cluster.setNodes({ lua: "127.0.0.1:2530" });
            const lh = await cluster.query("lua", "main");
            skynetcore.runtime.error("JS2LUA handle=" + lh);
            const r = await cluster.call("lua", "@main", "from-js", 33);
            skynetcore.runtime.error("JS2LUA RESULT: " + JSON.stringify(r.map(v => v instanceof Map ? [...v.entries()] : v)));
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
