// TLS acceptance: client test orchestration. Starts the TLS echo server,
// runs HTTPS + WSS client tests, prints TLS <scenario> OK / TLS FAIL markers.
"use strict";

const crypt = require("../../js/internal/crypt-core.js");
const websocket = require("skyjs/websocket");
// httpc is the internal HTTP client over the same core as the `http` facade;
// the legacy global was removed in NC4.5.
const httpc = require("../../js/internal/http-core.js").httpc;

let failCount = 0;

function check(label, ok, detail) {
    if (ok) {
        console.log("TLS " + label + " OK");
    } else {
        console.log("TLS FAIL " + label + (detail ? ": " + detail : ""));
        failCount++;
    }
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => msg);
});

skynet.timeout(1, async () => {
    // TLS availability check
    if (!skynetcore.tls) {
        console.log("TLS SKIP (OpenSSL not available)");
        console.log("TLS ALL OK");
        return;
    }

    const server = skynet.newservice("snjs test/service/tls-server.js");
    const httpsPort = await skynet.call(server, "text", "ping_https");
    const wssPort = await skynet.call(server, "text", "ping_wss");
    const base = "https://127.0.0.1:" + httpsPort;
    const wssUrl = "wss://127.0.0.1:" + wssPort;
    const tlsOpts = { caFile: "test/certs/ca.pem" };

    try {
        // ==== HTTPS tests ====

        // GET 200
        {
            const r = await httpc.get(base, "/echo", {}, null, tlsOpts);
            const p = JSON.parse(r.body);
            check("https_get", r.status === 200 && p.method === "GET" && p.url === "/echo",
                "status=" + r.status + " body=" + r.body);
        }

        // POST binary
        {
            const r = await httpc.request("POST", base, "/echo", {},
                { "content-type": "application/octet-stream" }, "tls_payload", tlsOpts);
            const p = JSON.parse(r.body);
            check("https_post", r.status === 200 && p.body === "tls_payload",
                "body=" + p.body);
        }

        // Keep-alive reuse (3 GETs on 1 TCP connection)
        {
            httpc.closeAllKeepalive();
            const before = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            console.error("TLS keepalive: baseline conn_count=" + before);
            console.error("TLS keepalive req1 sending");
            await httpc.get(base, "/echo", {}, null, tlsOpts);
            console.error("TLS keepalive resp1 OK");
            console.error("TLS keepalive req2 sending");
            await httpc.get(base, "/echo", {}, null, tlsOpts);
            console.error("TLS keepalive resp2 OK");
            console.error("TLS keepalive req3 sending");
            await httpc.get(base, "/echo", {}, null, tlsOpts);
            console.error("TLS keepalive resp3 OK");
            const after = parseInt(await skynet.call(server, "text", "conn_count"), 10);
            console.error("TLS keepalive: final conn_count=" + after);
            check("https_keepalive", after - before === 1,
                "conn_delta=" + (after - before) + " expected=1");
        }

        // ==== WSS tests ====
        const decoder = new TextDecoder();
        function decode(ab) { return decoder.decode(new Uint8Array(ab)); }

        // Text echo
        {
            const id = await websocket.connect(wssUrl, null, null, tlsOpts);
            websocket.write(id, "hello wss");
            const r = await websocket.read(id);
            check("wss_text", !r.close && r.type === "text" &&
                decode(r.data) === "hello wss",
                "got " + (r.close ? "close" : decode(r.data)));
            websocket.close(id, 1000);
        }

        // Binary echo
        {
            const id = await websocket.connect(wssUrl, null, null, tlsOpts);
            const bin = new Uint8Array([1, 2, 3, 0, 255, 128]).buffer;
            const binHex = crypt.hexEncode(bin);
            websocket.write(id, bin, "binary");
            const r = await websocket.read(id);
            check("wss_binary", !r.close && r.type === "binary" &&
                crypt.hexEncode(r.data) === binHex,
                "type=" + r.type + " hex=" + crypt.hexEncode(r.data));
            websocket.close(id, 1000);
        }

        // Client close
        {
            const id = await websocket.connect(wssUrl, null, null, tlsOpts);
            websocket.write(id, "before_close");
            const r = await websocket.read(id);
            check("wss_echo_before_close", !r.close && decode(r.data) === "before_close",
                "got " + (r.close ? "close" : decode(r.data)));
            websocket.close(id, 1000, "goodbye");
            check("wss_client_close", websocket.isClose(id), "not closed");
        }

        // Server close
        {
            const id = await websocket.connect(wssUrl, null, null, tlsOpts);
            websocket.write(id, "close_me");
            const r = await websocket.read(id);
            check("wss_server_close", r.close === true && r.code === 1000,
                "close=" + r.close + " code=" + r.code);
        }

    } catch (e) {
        console.log("TLS FAIL exception: " + (e && (e.message || e)));
        console.log(e && e.stack || "");
        failCount++;
    }

    httpc.closeAllKeepalive();

    if (failCount === 0) {
        console.log("TLS ALL OK");
    } else {
        console.log("TLS FAIL total=" + failCount);
    }
});
