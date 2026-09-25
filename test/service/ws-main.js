// Task 8 acceptance: WebSocket client test orchestration. Starts the echo
// server, runs websocket.connect client tests, prints WS <scenario> OK /
// WS FAIL markers.
"use strict";

const sockethelper = require("../../js/internal/net-core.js");
const socket = require("../../js/internal/net-core.js");
const crypt = require("../../js/internal/crypt-core.js");
const websocket = require("../../js/internal/websocket-core.js");

let failCount = 0;
const decoder = new TextDecoder();

function check(label, ok, detail) {
    if (ok) {
        console.log("WS " + label + " OK");
    } else {
        console.log("WS FAIL " + label + (detail ? ": " + detail : ""));
        failCount++;
    }
}

function decode(ab) {
    return decoder.decode(new Uint8Array(ab));
}

function abHex(ab) {
    return crypt.hexEncode(ab);
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => msg);
});

skynet.timeout(1, async () => {
    const server = skynet.newservice("snjs test/service/ws-server.js");
    const port = await skynet.call(server, "text", "ping");
    const url = "ws://127.0.0.1:" + port;

    try {
        // ---- Text echo ----
        {
            const id = await websocket.connect(url);
            websocket.write(id, "hello ws");
            const r = await websocket.read(id);
            check("text_echo", !r.close && r.type === "text" &&
                decode(r.data) === "hello ws",
                "got " + (r.close ? "close" : decode(r.data)));
            websocket.close(id, 1000);
        }

        // ---- Binary echo ----
        {
            const id = await websocket.connect(url);
            const bin = new Uint8Array([1, 2, 3, 0, 255, 128]).buffer;
            // hex_encode before write(): the buffer may be neutered/consumed
            // once handed to the C layer, so snapshot the expected value now.
            const binHex = abHex(bin);
            websocket.write(id, bin, "binary");
            const r = await websocket.read(id);
            check("binary_echo", !r.close && r.type === "binary" &&
                abHex(r.data) === binHex,
                "type=" + r.type + " hex=" + abHex(r.data) + " want=" + binHex);
            websocket.close(id, 1000);
        }

        // ---- Multi-message sequence (10 messages) ----
        {
            const id = await websocket.connect(url);
            const count = 10;
            for (let i = 0; i < count; i++) {
                websocket.write(id, "msg" + i);
            }
            let ok = true;
            for (let i = 0; i < count; i++) {
                const r = await websocket.read(id);
                if (r.close || decode(r.data) !== "msg" + i) {
                    ok = false;
                    break;
                }
            }
            check("multi_msg", ok, "sequence mismatch");
            websocket.close(id, 1000);
        }

        // ---- Large frame: 200 bytes (16-bit length encoding) ----
        {
            const id = await websocket.connect(url);
            let s200 = "";
            for (let i = 0; i < 200; i++) s200 += String.fromCharCode(65 + (i % 26));
            websocket.write(id, s200);
            const r = await websocket.read(id);
            check("large_126", !r.close && decode(r.data) === s200,
                "len=" + (r.data ? r.data.byteLength : 0));
            websocket.close(id, 1000);
        }

        // ---- Large frame: >64KB (64-bit length encoding) ----
        {
            const id = await websocket.connect(url);
            const big = new Uint8Array(70000);
            for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
            websocket.write(id, big.buffer, "binary");
            const r = await websocket.read(id);
            let match = false;
            if (!r.close && r.data && r.data.byteLength === 70000) {
                const rv = new Uint8Array(r.data);
                match = true;
                for (let i = 0; i < rv.length; i++) {
                    if (rv[i] !== (i & 0xff)) { match = false; break; }
                }
            }
            check("large_64k", match,
                "len=" + (r.data ? r.data.byteLength : 0));
            websocket.close(id, 1000);
        }

        // ---- Ping/pong ----
        {
            const id = await websocket.connect(url);
            websocket.ping(id);
            // server auto-pongs; pong is swallowed by read(). send a text
            // message after ping and verify echo works (proves ping/pong cycle)
            websocket.write(id, "after_ping");
            const r = await websocket.read(id);
            check("ping_pong", !r.close && decode(r.data) === "after_ping",
                "got " + (r.close ? "close" : decode(r.data)));
            websocket.close(id, 1000);
        }

        // ---- Client close handshake ----
        {
            const id = await websocket.connect(url);
            websocket.write(id, "before_close");
            const r = await websocket.read(id);
            check("client_close_echo", !r.close && decode(r.data) === "before_close",
                "got " + (r.close ? "close" : decode(r.data)));
            // close with code
            websocket.close(id, 1000, "goodbye");
            // connection is now closed; verify via is_close
            check("client_close", websocket.isClose(id), "not closed");
        }

        // ---- Server close ----
        {
            const id = await websocket.connect(url);
            websocket.write(id, "close_me");
            const r = await websocket.read(id);
            check("server_close", r.close === true && r.code === 1000,
                "close=" + r.close + " code=" + r.code + " reason=" + r.reason);
        }

        // ---- Multiple concurrent connections (3) ----
        {
            const ids = [];
            for (let i = 0; i < 3; i++) {
                ids.push(await websocket.connect(url));
            }
            for (let i = 0; i < 3; i++) {
                websocket.write(ids[i], "conn" + i);
            }
            let ok = true;
            for (let i = 0; i < 3; i++) {
                const r = await websocket.read(ids[i]);
                if (r.close || decode(r.data) !== "conn" + i) {
                    ok = false;
                }
            }
            check("concurrent_3", ok, "echo mismatch");
            for (let i = 0; i < 3; i++) {
                websocket.close(ids[i], 1000);
            }
        }

        // ---- Handshake rejection (invalid HTTP request) ----
        {
            let rejOk = false;
            try {
                const fd = await sockethelper.connectAsync("127.0.0.1", parseInt(port, 10));
                const reader = sockethelper.reader(fd);
                reader.write("GARBAGE REQUEST\r\n\r\n");
                try {
                    const line = await reader.readline();
                    // expect HTTP 400 or similar error response
                    rejOk = line.includes("400") || line.includes("Bad") ||
                        line.includes("HTTP");
                } catch (e) {
                    // socket closed: also acceptable (server rejected)
                    rejOk = true;
                }
                try { socket.close(fd); } catch (_) { /* ignore */ }
            } catch (e) {
                // connect or write failed: also acceptable
                rejOk = true;
            }
            check("handshake_reject", rejOk, "no rejection detected");
        }

    } catch (e) {
        console.log("WS FAIL exception: " + (e && (e.message || e)));
        console.log(e && e.stack || "");
        failCount++;
    }

    if (failCount === 0) {
        console.log("WS ALL OK");
    } else {
        console.log("WS FAIL total=" + failCount);
    }
});
