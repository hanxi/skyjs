// TLS acceptance: HTTPS + WSS echo server. Listens on two ports:
// HTTPS (server-side TLS upgrade + HTTP echo) and WSS (websocket.accept
// with TLS). Responds to "text" protocol for port discovery and conn_count.
"use strict";

const sockethelper = require("../../js/internal/net-core.js");
const socket = require("../../js/internal/net-core.js");
const websocket = require("../../js/internal/websocket-core.js");
const httpCore = require("../../js/internal/http-core.js");
const httpd = httpCore.httpd;
const httpc = httpCore.httpc;
const httpInternal = httpCore.httpInternal;

const HTTPS_PORT = 18870;
const WSS_PORT = 18871;
let connCount = 0;

// ---- HTTPS handler (mirrors http-server.js with TLS upgrade) ----

function handleHttps(fd, addr) {
    connCount++;
    const reader = sockethelper.reader(fd);

    skynet.fork(async () => {
        try {
            await sockethelper.tlsUpgrade(reader, null, true,
                "test/certs/server.pem", "test/certs/server.key");

            const writeFn = (data) => reader.write(data);

            while (true) {
                const req = await httpd.readRequest(reader);
                if (req.code !== 200) {
                    httpd.writeResponse(writeFn, req.code, "Bad request");
                    break;
                }

                const echo = JSON.stringify({
                    method: req.method,
                    url: req.url,
                    body: req.body,
                    bodyLen: req.body ? req.body.length : 0,
                });

                // default: echo with keep-alive
                httpd.writeResponse(writeFn, 200, echo);
            }
        } catch (e) {
            // socket closed or TLS error
        }
        try { socket.close(fd); } catch (_) { /* ignore */ }
    });
}

// ---- WSS handler (mirrors ws-server.js echo with TLS) ----

const wssHandler = {
    message(id, data, opcode) {
        if (opcode === "text") {
            const text = new TextDecoder().decode(new Uint8Array(data));
            if (text === "close_me") {
                websocket.close(id, 1000, "server_close");
                return;
            }
        }
        // echo back with same opcode
        websocket.write(id, data, opcode);
    },
    close(id, code, reason) {
        // normal close — nothing to do
    },
};

skynet.start(() => {
    socket.listen("127.0.0.1", HTTPS_PORT, handleHttps);
    console.log("TLS_HTTPS listening on " + HTTPS_PORT);

    socket.listen("127.0.0.1", WSS_PORT, (fd, addr) => {
        skynet.fork(async () => {
            await websocket.accept(fd, wssHandler, "wss", addr, {
                tls: {
                    certfile: "test/certs/server.pem",
                    keyfile: "test/certs/server.key",
                },
            });
        });
    });
    console.log("TLS_WSS listening on " + WSS_PORT);

    skynet.dispatch("text", (msg) => {
        if (msg === "ping_https") return String(HTTPS_PORT);
        if (msg === "ping_wss") return String(WSS_PORT);
        if (msg === "conn_count") return String(connCount);
        return "";
    });
});
