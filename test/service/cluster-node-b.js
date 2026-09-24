// Task 6 acceptance, node B (port 2529): launches skyclusterd, opens the
// listener, registers "svc2", and serves lua-protocol requests.
const cluster = require("../../js/builtins/skyjs/cluster.js");

skynet.register("main");
skynet.newservice("skyclusterd");
cluster.init();
cluster.open(2529);
cluster.register("svc2");

skynet.start(() => {
    skynet.dispatch("lua", (buf) => {
        const vals = skynet.unpack(buf);
        return skynet.pack("svc2:" + vals[0], vals[1] + 1);
    });
});
