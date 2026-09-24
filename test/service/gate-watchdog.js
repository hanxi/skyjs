// Watchdog service (acceptance sample), mirrors the skynet gate/watchdog model.
// Launches the gate, opens its listen port, and spawns one agent per accepted
// connection then binds it via the gate's "forward" command.
"use strict";

const socket = require("../../js/internal/net-core.js");

let gate = 0;
const agents = new Map();   // fd -> agent handle

skynet.start(() => {
    skynet.dispatch("lua", async (msg, source) => {
        const args = skynet.unpack(msg);
        const cmd = args[0];
        if (cmd === "wait_ready") {
            // args: [port]; launch the gate and open it before returning so the
            // caller can safely connect afterwards
            gate = skynet.newservice("snjs test/service/gate-server.js");
            await skynet.call(gate, "lua", skynet.pack("open", args[1] | 0, skynet.self()));
            skynetcore.runtime.error("WATCHDOG gate ready on port " + (args[1] | 0));
            return skynet.pack(true);
        }
        if (cmd === "socket") {
            const sub = args[1];
            const fd = args[2];
            if (sub === "open") {
                const agent = skynet.newservice("snjs test/service/gate-agent.js");
                agents.set(fd, agent);
                await skynet.call(gate, "lua", skynet.pack("forward", fd, agent, 0));
                skynetcore.runtime.error("WATCHDOG bound agent " + agent + " to fd " + fd);
            } else if (sub === "close" || sub === "error") {
                agents.delete(fd);
                skynetcore.runtime.error("WATCHDOG fd " + fd + " " + sub);
            }
            // socket notifications arrive via skynet.send (no session): no reply
            return;
        }
        return skynet.pack(true);
    });
});
