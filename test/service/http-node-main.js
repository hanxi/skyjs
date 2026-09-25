"use strict";

// NC4.3 acceptance: Node http server + client + global fetch on one core.

const testing = require("skyjs/testing");
const http = require("http");
const https = require("https");
const url = require("url");

const PORT = 18902;

skynet.timeout(1, async () => {
    const server = http.createServer((req, res) => {
        if (req.url === "/echo") {
            let body = "";
            req.on("data", (c) => { body += c.toString(); });
            req.on("end", () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ method: req.method, url: req.url, body }));
            });
            return;
        }
        if (req.url === "/404") {
            res.writeHead(404);
            res.end("nope");
            return;
        }
        res.writeHead(200);
        res.end("hello");
    });
    await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

    // ---- http.request GET ----
    const get = await http.request({ host: "127.0.0.1", port: PORT, path: "/", method: "GET" });
    testing.equal(get.statusCode, 200, "http status");
    testing.equal(get.body.toString(), "hello", "http body");

    // ---- http.request POST with body ----
    const post = await http.request({
        host: "127.0.0.1", port: PORT, path: "/echo", method: "POST",
        headers: { "content-type": "text/plain" }, body: "payload",
    });
    const parsed = JSON.parse(post.body.toString());
    testing.equal(parsed.method, "POST", "post method");
    testing.equal(parsed.body, "payload", "post body echoed");

    // ---- 404 ----
    const missing = await http.get({ host: "127.0.0.1", port: PORT, path: "/404" });
    testing.equal(missing.statusCode, 404, "404 status");

    // ---- fetch over the same core ----
    const res = await fetch("http://127.0.0.1:" + PORT + "/echo", {
        method: "POST", body: "fetch-body",
    });
    testing.equal(res.status, 200, "fetch status");
    testing.ok(res.ok, "fetch ok");
    const data = await res.json();
    testing.equal(data.body, "fetch-body", "fetch body echoed");
    testing.ok(res.headers.get("content-type").includes("json"), "fetch headers");

    // ---- https reports unavailability without OpenSSL ----
    let httpsErr = null;
    try { https.createServer({}); } catch (err) { httpsErr = err; }
    if (httpsErr !== null) {
        testing.equal(httpsErr.code, "ERR_UNSUPPORTED_PLATFORM", "https unavailable explicit");
    }

    server.close();
    skynetcore.runtime.error("HTTP_NODE_OK request=1 post=1 404=1 fetch=1 https=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "HTTP_NODE:" + msg);
});
