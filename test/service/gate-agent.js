// Agent service (acceptance sample). Registers the "client" protocol and echoes
// each client frame's raw payload back to the socket. Client frames arrive via
// the gate's skynet.redirect as PTYPE_CLIENT: msg is the ArrayBuffer payload and
// the session carries the connection fd.
"use strict";

const socket = require("../../js/internal/net-core.js");

skynet.start(() => {
    skynet.dispatch("client", (msg, source, session) => {
        const fd = session;
        // msg is the reassembled packet payload (binary-safe ArrayBuffer);
        // echo it straight back to the client. No reply is sent for PTYPE_CLIENT.
        socket.write(fd, msg);
    });
});
