// Task 8 acceptance: HTTP client test orchestration. Starts the echo server,
// runs httpc client tests, prints HTTP <scenario> OK / HTTP FAIL markers.
"use strict";

const socket = require("../../js/internal/net-core.js");
const httpCore = require("../../js/internal/http-core.js");
const httpd = httpCore.httpd;
const httpc = httpCore.httpc;
const httpInternal = httpCore.httpInternal;

let failCount = 0;

function check(label, ok, detail) {
    if (ok) {
        console.log("HTTP " + label + " OK");
    } else {
        console.log("HTTP FAIL " + label + (detail ? ": " + detail : ""));
        failCount++;
    }
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => msg);
});

skynet.timeout(1, async () => {
    const server = skynet.newservice("snjs test/service/http-server.js");
    const port = await skynet.call(server, "text", "ping");
    const base = "http://127.0.0.1:" + port;

    try {
        // ---- GET 200 ----
        {
            const r = await httpc.get(base, "/echo", {});
            const p = JSON.parse(r.body);
            check("get_200", r.status === 200 && p.method === "GET" && p.url === "/echo",
                "status=" + r.status + " body=" + r.body);
        }

        // ---- POST form ----
        {
            const r = await httpc.post(base, "/echo", { name: "test", val: "123" }, {});
            const p = JSON.parse(r.body);
            check("post_form", r.status === 200 && p.method === "POST" &&
                p.body.includes("name") && p.body.includes("123"),
                "body=" + r.body);
        }

        // ---- POST binary body ----
        {
            const r = await httpc.request("POST", base, "/echo", {},
                { "content-type": "application/octet-stream" }, "binary_payload_here");
            const p = JSON.parse(r.body);
            check("post_binary", r.status === 200 && p.body === "binary_payload_here",
                "body=" + p.body);
        }

        // ---- HEAD ----
        {
            const status = await httpc.head(base, "/echo", {});
            check("head", status === 200, "status=" + status);
        }

        // ---- Large body (>64KB) ----
        {
            let large = "";
            for (let i = 0; i < 4200; i++) large += "0123456789abcdef";  // 67200 bytes
            const r = await httpc.request("POST", base, "/echo", {},
                { "content-type": "text/plain" }, large);
            const p = JSON.parse(r.body);
            check("large_body", r.status === 200 && p.bodyLen === large.length,
                "body_len=" + p.bodyLen + " expected=" + large.length);
        }

        // ---- Chunked transfer encoding ----
        {
            const r = await httpc.get(base, "/chunked", {});
            check("chunked", r.status === 200 && r.body === "chunk1chunk2chunk3",
                "body=" + r.body);
        }

        // ---- 404 ----
        {
            const r = await httpc.get(base, "/404", {});
            check("404", r.status === 404, "status=" + r.status);
        }

        // ---- Keep-Alive reuse: 3 GETs use 1 TCP connection ----
        {
            httpc.closeAllKeepalive();
            const before = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            await httpc.get(base, "/echo", {});
            await httpc.get(base, "/echo", {});
            await httpc.get(base, "/echo", {});
            const after = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            check("keepalive_reuse", after - before === 1,
                "conn_delta=" + (after - before) + " expected=1");
        }

        // ---- Keep-Alive close: server sends Connection: close ----
        {
            httpc.closeAllKeepalive();
            const before = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            await httpc.get(base, "/close", {});
            // pool should NOT reuse this connection — next request opens a new one
            await httpc.get(base, "/echo", {});
            const after = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            check("keepalive_close", after - before === 2,
                "conn_delta=" + (after - before) + " expected=2");
        }

        // ---- Keep-Alive stale: server silently closes ----
        {
            httpc.closeAllKeepalive();
            // GET /stale_close: server responds OK then closes the socket
            // httpc pools the connection (no Connection: close header)
            const r1 = await httpc.get(base, "/stale_close", {});
            check("stale_setup", r1.status === 200, "status=" + r1.status);

            // next request: httpc gets stale connection, retry auto-reconnects
            const r2 = await httpc.get(base, "/echo", {});
            const p2 = JSON.parse(r2.body);
            check("keepalive_stale", r2.status === 200 && p2.url === "/echo",
                "status=" + r2.status + " url=" + (p2 && p2.url));
        }

    } catch (e) {
        console.log("HTTP FAIL exception: " + (e && (e.message || e)));
        console.log(e && e.stack || "");
        failCount++;
    }

    httpc.closeAllKeepalive();

    if (failCount === 0) {
        console.log("HTTP ALL OK");
    } else {
        console.log("HTTP FAIL total=" + failCount);
    }
});
