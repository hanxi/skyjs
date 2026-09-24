// Gate service (acceptance sample), a JS port of 3rd/skynet/service/gate.lua.
// Uses the gateserver runtime lib: frames client traffic with the C netpack
// buffer, forwards each packet to the connection's agent via skynet.redirect
// (raw ArrayBuffer, zero string conversion), or to the watchdog when unbound.
//
// lua command protocol (from the watchdog):
//   open   port watchdog   -> listen and record the watchdog
//   forward fd agent client-> bind an agent to fd and start reading it
//   accept fd             -> start reading fd (no agent bind)
//   kick   fd             -> close fd
"use strict";

const socket = require("../../js/internal/net-core.js");
const gateserver = require("../../js/builtins/skyjs/gateserver.js");

const gate = gateserver;

let watchdog = 0;
const connection = new Map();   // fd -> { fd, ip, client, agent }

function unforward(c) {
    c.agent = 0;
    c.client = 0;
}

function closeFd(fd) {
    const c = connection.get(fd);
    if (c) {
        unforward(c);
        connection.delete(fd);
    }
}

const handler = {
    connect(fd, addr) {
        connection.set(fd, { fd, ip: addr, client: 0, agent: 0 });
        skynet.send(watchdog, "lua", "socket", "open", fd, addr || "");
    },
    message(fd, msg) {
        // msg is an ArrayBuffer (one reassembled netpack packet)
        const c = connection.get(fd);
        if (c && c.agent) {
            // forward the raw frame to the agent as PTYPE_CLIENT; session=fd
            skynet.redirect(c.agent, c.client, "client", fd, msg);
        } else {
            // no agent: hand the text to the watchdog (lossy, matches lua tostring)
            skynet.send(watchdog, "lua", "socket", "data", fd, skynetcore.seri.str(msg));
        }
    },
    disconnect(fd) {
        closeFd(fd);
        skynet.send(watchdog, "lua", "socket", "close", fd);
    },
    error(fd, err) {
        closeFd(fd);
        skynet.send(watchdog, "lua", "socket", "error", fd, err || "");
    },
    warning(fd, size) {
        skynet.send(watchdog, "lua", "socket", "warning", fd, size);
    },
};

function command(cmd, source, args) {
    if (cmd === "open") {
        watchdog = args[1] || source;
        return gate.open("0.0.0.0", args[0] | 0, 64);
    }
    if (cmd === "forward") {
        const fd = args[0];
        const c = connection.get(fd);
        if (c) {
            unforward(c);
            c.agent = args[1] || source;
            c.client = args[2] || 0;
            gate.openclient(fd);
        }
        return true;
    }
    if (cmd === "accept") {
        gate.openclient(args[0]);
        return true;
    }
    if (cmd === "kick") {
        gate.closeclient(args[0]);
        return true;
    }
    return false;
}

skynet.start(() => {
    gate.start(handler);
    skynet.dispatch("lua", (msg, source) => {
        const args = skynet.unpack(msg);
        return skynet.pack(command(args[0], source, args.slice(1)));
    });
});
