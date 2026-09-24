// HTTPS + WSS multi-user chat demo.
// Single port serves both static HTML (HTTP GET) and WebSocket upgrade.
// Usage: ./skyjs examples/chat/config.json
"use strict";

const sockethelper = require("../../js/internal/net-helper-core.js");
const socket = require("../../js/internal/net-core.js");
const websocket = require("../../js/internal/websocket-core.js");
const fsx = require("../../js/internal/fs-core.js");
const httpCore = require("../../js/internal/http-core.js");
const httpd = httpCore.httpd;

const HTTP_PORT = 8080;
const HTTPS_PORT = 8443;
const CERT_FILE = "test/certs/server.pem";
const KEY_FILE = "test/certs/server.key";

// --------------- global client state ---------------

const clients = new Map();   // fd -> { name, fd }
let nextId = 1;

const history = [];          // recent chat messages (msg-type broadcast objects)
const HISTORY_LIMIT = 50;

function formatTime() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return h + ":" + m + ":" + s;
}

function broadcast(msg) {
    const json = JSON.stringify(msg);
    for (const [_, client] of clients) {
        try { websocket.write(client.fd, json); } catch (_e) { /* ignore */ }
    }
}

function broadcastOnline() {
    const names = [];
    for (const [_, c] of clients) { names.push(c.name); }
    broadcast({ type: "online", count: names.length, names: names });
}

function onDisconnect(fd) {
    const client = clients.get(fd);
    if (client) {
        clients.delete(fd);
        broadcast({ type: "leave", name: client.name });
        broadcastOnline();
    }
}

// --------------- websocket handler factory ---------------

function makeHandler(fd) {
    let loggedIn = false;

    return {
        connect: function (_id) {
            // connection established, waiting for login message
        },
        message: function (_id, data, _opcode) {
            const text = new TextDecoder().decode(new Uint8Array(data));
            let msg;
            try { msg = JSON.parse(text); } catch (_e) { return; }

            if (!loggedIn) {
                if (msg.type === "login" && msg.name) {
                    const name = String(msg.name).trim();
                    if (!name) return;
                    for (const [_, c] of clients) {
                        if (c.name === name) {
                            websocket.write(fd, JSON.stringify({
                                type: "error",
                                text: "\u6635\u79f0 \"" + name + "\" \u5df2\u88ab\u4f7f\u7528",
                            }));
                            return;
                        }
                    }
                    loggedIn = true;
                    clients.set(fd, { name: name, fd: fd });

                    // replay chat history to the new user only
                    for (let i = 0; i < history.length; i++) {
                        try { websocket.write(fd, JSON.stringify(history[i])); } catch (_e) { /* ignore */ }
                    }
                    if (history.length > 0) {
                        try { websocket.write(fd, JSON.stringify({ type: "history_end" })); } catch (_e) { /* ignore */ }
                    }

                    broadcast({ type: "join", name: name });
                    broadcastOnline();
                }
                return;
            }

            if (msg.type === "msg" && msg.text) {
                const client = clients.get(fd);
                if (!client) return;
                const chatMsg = {
                    type: "msg",
                    name: client.name,
                    text: String(msg.text),
                    time: formatTime(),
                };
                history.push(chatMsg);
                if (history.length > HISTORY_LIMIT) {
                    history.shift();
                }
                broadcast(chatMsg);
            }
        },
        close: function (_id, _code, _reason) {
            onDisconnect(fd);
        },
        error: function (_id, _err) {
            onDisconnect(fd);
        },
    };
}

// --------------- connection handler ---------------

function handleConnection(fd, addr, useTls) {
    skynet.fork(async () => {
        const reader = sockethelper.reader(fd);
        try {
            if (useTls) {
                await sockethelper.tlsUpgrade(reader, null, true, CERT_FILE, KEY_FILE);
            }

            const req = await httpd.readRequest(reader);
            if (req.code !== 200) {
                const wf = (d) => reader.write(d);
                httpd.writeResponse(wf, req.code, "Bad Request");
                socket.close(fd);
                return;
            }

            const upgrade = req.header["upgrade"];
            if (upgrade && upgrade.toLowerCase() === "websocket") {
                await websocket.accept(fd, makeHandler(fd), "ws", addr, {
                    upgrade: { header: req.header, method: req.method, url: req.url },
                    reader: reader,
                });
            } else {
                const wf = (d) => reader.write(d);
                httpd.writeResponse(wf, 200, htmlContent, {
                    "Content-Type": "text/html; charset=utf-8",
                });
                socket.close(fd);
            }
        } catch (_e) {
            onDisconnect(fd);
            try { socket.close(fd); } catch (_e2) { /* ignore */ }
        }
    });
}

// --------------- html loader ---------------

let htmlContent = "";

function loadHtml() {
    try {
        htmlContent = fsx.readTextFile("examples/chat/chat.html");
        console.log("chat: loaded chat.html (" + htmlContent.length + " bytes)");
    } catch (e) {
        skynetcore.runtime.error("chat: failed to read examples/chat/chat.html: " + (e && (e.message || e)));
        htmlContent = "<!doctype html><meta charset=\"utf-8\"><title>error</title>" +
            "<h1>chat.html not found</h1>" +
            "<p>Run skyjs from the repository root directory.</p>";
    }
}

// --------------- start ---------------

skynet.start(() => {
    loadHtml();

    socket.listen("0.0.0.0", HTTP_PORT, (fd, addr) => handleConnection(fd, addr, false));
    console.log("Chat HTTP  listening on http://0.0.0.0:" + HTTP_PORT + "/");

    if (skynetcore.tls) {
        socket.listen("0.0.0.0", HTTPS_PORT, (fd, addr) => handleConnection(fd, addr, true));
        console.log("Chat HTTPS listening on https://0.0.0.0:" + HTTPS_PORT + "/");
    } else {
        console.log("TLS not available (build with make TLS=openssl for HTTPS)");
    }
});
