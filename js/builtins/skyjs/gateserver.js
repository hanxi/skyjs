// skyjs gateserver runtime lib. Port of 3rd/skynet/lualib/snax/gateserver.lua:
// a TCP gate front-end that frames traffic with the C netpack buffer (2-byte
// big-endian length prefix) and dispatches per-connection events to a handler.
//
// Loaded by snjs after cluster.js (env key "jsGateserver", default
// "./js/gateserver.js"). A gate service calls gateserver.start(handler), which
// switches the service into netpack mode (skynetcore.net.netpackMode) and
// installs the socket event handler; the C worker_cb then routes PTYPE_SOCKET
// DATA through the frame buffer and delivers {np, event, id, ud, data} objects.
//
// Design note (mirrors gateserver.lua): an accepted connection is registered on
// the "open" (ACCEPT) event but NOT read from until gateserver.openclient(fd)
// -- the gate forwards the fd to an agent/watchdog first, then opens it.
(function () {
    "use strict";

    const hooks = require("../../internal/runtime-hooks.js");

    const core = globalThis.skynetcore;
    const net = require("../../internal/net-core.js");
    const netpack = core.netpack;

    let listenSocket = 0;
    let maxclient = 1024;
    let clientNumber = 0;
    let useNodelay = false;
    let userHandler = null;

    // fd -> true (connected) / false (read-closed); nil (deleted) once gone
    const connection = new Map();

    function dispatchMsg(fd, msg) {
        if (connection.get(fd)) {
            userHandler.message(fd, msg);
        } else {
            core.runtime.error("gateserver drop message from fd " + fd);
        }
    }

    // the single socket handler installed via __snjs_set_socket_handler; every
    // event carries m.np === true and a string m.event naming the MSG kind
    function onSocket(m) {
        switch (m.event) {
            case "data":
                dispatchMsg(m.id, m.data);
                break;
            case "more": {
                let p = netpack.pop();
                while (p) {
                    dispatchMsg(p.fd, p.data);
                    p = netpack.pop();
                }
                break;
            }
            case "open":
                // ACCEPT: m.id is the newly accepted connection fd
                if (clientNumber >= maxclient) {
                    core.net.shutdown(m.id);
                    return;
                }
                clientNumber += 1;
                if (useNodelay) core.net.nodelay(m.id);
                connection.set(m.id, true);
                userHandler.connect(m.id, m.data);
                break;
            case "close":
                if (m.id !== listenSocket) {
                    clientNumber -= 1;
                    if (connection.has(m.id)) connection.delete(m.id);
                    if (userHandler.disconnect) userHandler.disconnect(m.id);
                } else {
                    listenSocket = 0;
                }
                break;
            case "error":
                if (m.id === listenSocket) {
                    core.runtime.error("gateserver accept error: " + m.data);
                } else {
                    core.net.shutdown(m.id);
                    if (userHandler.error) userHandler.error(m.id, m.data);
                }
                break;
            case "warning":
                if (userHandler.warning) userHandler.warning(m.id, m.ud);
                break;
            case "init":
                // listen socket bind confirmation; nothing to do
                break;
        }
    }

    const gateserver = {
        // start reading an accepted connection (after forward/accept)
        openclient(fd) {
            if (connection.get(fd)) net.resume(fd | 0);
        },
        closeclient(fd) {
            if (connection.has(fd)) {
                connection.delete(fd);
                net.close(fd | 0);
            }
        },
        // create and start the listen socket; returns the listen fd
        open(host, port, backlog, maxClient, nodelay) {
            maxclient = maxClient || 1024;
            useNodelay = !!nodelay;
            listenSocket = net.listen(String(host || "0.0.0.0"), port | 0, backlog || 64);
            core.runtime.error("gateserver listen port " + port + " -> id " + listenSocket);
            if (listenSocket >= 0) net.resume(listenSocket | 0);
            return listenSocket;
        },
        close() {
            if (listenSocket) net.close(listenSocket | 0);
        },
        // install handler + switch this service into netpack mode
        start(handler) {
            if (!handler || typeof handler.message !== "function" ||
                typeof handler.connect !== "function") {
                throw new Error("gateserver.start: handler.message and handler.connect are required");
            }
            userHandler = handler;
            core.net.netpackMode();
            hooks.setSocketHandler(onSocket);
        },
    };
    module.exports = gateserver;
})();
