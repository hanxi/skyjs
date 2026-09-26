// Task 8 acceptance: WebSocket echo server. Listens on a port and uses
// websocket.accept to echo text/binary frames back to the client.
// Special message "close_me" triggers a server-initiated close.
"use strict";

const net = require("net");
const websocket = require("skyjs/websocket");

const PORT = 18870;

skynet.start(() => {
    const server = net.createServer((socket) => {
        skynet.fork(() => {
            return websocket.accept(socket, {
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
            }, "ws", socket.remoteAddress);
        });
    });
    server.listen(PORT, "127.0.0.1");
    console.log("WS_ECHO listening on " + PORT);

    skynet.dispatch("text", (msg) => {
        if (msg === "ping") return String(PORT);
        return "";
    });
});
