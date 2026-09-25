// Task 8 acceptance: HTTP echo server. Listens on a port, parses HTTP
// requests via httpd, and echoes method+url+body back as JSON. Supports
// keep-alive, chunked responses, forced close, and stale-connection testing.
"use strict";

const sockethelper = require("../../js/internal/net-core.js");
const socket = require("../../js/internal/net-core.js");
const httpd = require("../../js/internal/http-core.js").httpd;

const PORT = 18860;
let connCount = 0;

function handleConnection(fd, addr) {
    connCount++;
    const reader = sockethelper.reader(fd);
    const writeFn = (data) => reader.write(data);

    skynet.fork(async () => {
        try {
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

                if (req.url === "/404") {
                    httpd.writeResponse(writeFn, 404, "Not Found");
                    continue;
                }

                if (req.url === "/close") {
                    httpd.writeResponse(writeFn, 200, echo,
                        { "Connection": "close" });
                    break;
                }

                // stale-connection test: respond normally (no Connection: close)
                // then break the loop so the socket closes server-side
                if (req.url === "/stale_close") {
                    httpd.writeResponse(writeFn, 200, echo);
                    break;
                }

                if (req.url === "/chunked") {
                    const data = "chunk1|chunk2|chunk3";
                    const parts = data.split("|");
                    let idx = 0;
                    httpd.writeResponse(writeFn, 200, () => {
                        if (idx >= parts.length) return null;
                        return parts[idx++];
                    });
                    continue;
                }

                // default: echo with keep-alive
                httpd.writeResponse(writeFn, 200, echo);
            }
        } catch (e) {
            // socket closed or other error
        }
        try { socket.close(fd); } catch (_) { /* ignore */ }
    });
}

skynet.start(() => {
    socket.listen("127.0.0.1", PORT, handleConnection);
    console.log("HTTP_ECHO listening on " + PORT);

    skynet.dispatch("text", (msg) => {
        if (msg === "ping") return String(PORT);
        if (msg === "conn_count") return String(connCount);
        return "";
    });
});
