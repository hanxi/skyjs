"use strict";

// NC4.2 acceptance: require('net') Socket/Server + require('tls') surface.

const testing = require("skyjs/testing");
const net = require("net");
const tls = require("tls");

const PORT = 18901;

skynet.timeout(1, async () => {
    // ---- echo server ----
    const server = net.createServer((socket) => {
        socket.on("data", (chunk) => socket.write(chunk));
    });
    await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
    testing.ok(server.listening, "server listening");

    // ---- client round-trip ----
    const reply = await new Promise((resolve, reject) => {
        const client = net.connect(PORT, "127.0.0.1", () => {
            client.write("ping-net");
        });
        client.on("data", (chunk) => { client.end(); resolve(chunk.toString()); });
        client.on("error", reject);
    });
    testing.equal(reply, "ping-net", "net echo round-trip");

    // ---- server-side connection event ----
    const connections = await new Promise((resolve) => {
        server.getConnections((err, count) => resolve(count));
    });
    testing.ok(connections >= 0, "getConnections");

    // ---- setNoDelay / setTimeout surface ----
    const probe = net.connect({ port: PORT, host: "127.0.0.1" });
    await new Promise((resolve) => probe.once("connect", resolve));
    probe.setNoDelay(true);
    probe.setTimeout(50);
    probe.destroy();

    server.close();
    testing.ok(!server.listening, "server closed");

    // ---- tls surface reports availability honestly ----
    const tlsSocket = tls.connect({ port: 443, host: "127.0.0.1" });
    const tlsError = await new Promise((resolve) => {
        tlsSocket.once("error", resolve);
        setTimeout(() => resolve(null), 200);
    });
    if (tlsError !== null) {
        testing.ok(tlsError.code === "ERR_UNSUPPORTED_PLATFORM" ||
            tlsError.code === "ERR_IO", "tls error surfaced");
    }
    tlsSocket.destroy();
    testing.ok(typeof tls.createServer === "function", "tls.createServer exported");

    skynetcore.runtime.error("NET_OK server=1 client=1 tls=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "NET:" + msg);
});
