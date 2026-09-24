// Task 8 acceptance: WebSocket echo server. Listens on a port and uses
// websocket.accept to echo text/binary frames back to the client.
// Special message "close_me" triggers a server-initiated close.
"use strict";

const socket = require("../../js/internal/net-core.js");
const websocket = require("../../js/internal/websocket-core.js");

const PORT = 18870;

skynet.start(() => {
    socket.listen("127.0.0.1", PORT, (fd, addr) => {
        skynet.fork(() => {
            return websocket.accept(fd, {
                message(id, data, opcode) {
                    // decode text to check for special commands
                    if (opcode === "text") {
                        const text = new TextDecoder().decode(new Uint8Array(data));
                        if (text === "close_me") {
                            websocket.close(id, 1000, "server bye");
                            return;
                        }
                    }
                    // echo back with same opcode
                    websocket.write(id, data, opcode);
                },
                close(id, code, reason) {
                    // normal close — nothing to do
                },
            }, "ws", addr);
        });
    });
    console.log("WS_ECHO listening on " + PORT);

    skynet.dispatch("text", (msg) => {
        if (msg === "ping") return String(PORT);
        return "";
    });
});
