"use strict";

// Node `https` facade: http semantics over the tls transport. Falls back to a
// clear ERR_UNSUPPORTED_PLATFORM error when the build lacks OpenSSL.

const http = require("./http.js");
const tls = require("./tls.js");
const errors = require("../internal/errors.js");

function ensureTls() {
    if (typeof skynetcore.tls !== "object" || skynetcore.tls === null) {
        throw errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
            "https requires an OpenSSL build (make TLS=openssl)");
    }
}

function createServer(options, requestListener) {
    ensureTls();
    return http.createServer(options, requestListener);
}

function request(options, callback) {
    ensureTls();
    return http.request(options, callback);
}

function get(options, callback) {
    return request(options, callback);
}

module.exports = {
    createServer,
    request,
    get,
    Server: http.Server,
    IncomingMessage: http.IncomingMessage,
    ServerResponse: http.ServerResponse,
    Agent: http.Agent,
    globalAgent: null,
    STATUS_CODES: http.STATUS_CODES,
};
