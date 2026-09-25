"use strict";

// Node `tls` facade (common subset) over skynetcore.tls. Requires an OpenSSL
// build (TLS=openssl); otherwise connect() reports ERR_UNSUPPORTED_PLATFORM.

const { EventEmitter } = require("./events.js");
const net = require("./net.js");
const errors = require("../internal/errors.js");

function tlsAvailable() {
    return typeof skynetcore.tls === "object" && skynetcore.tls !== null;
}

class TLSSocket extends net.Socket {
    constructor(socket, options) {
        super(options);
        this.authorized = false;
        this.authorizationError = null;
        this.servername = (options && options.servername) || this.remoteAddress;
        if (socket instanceof net.Socket) {
            this._fd = socket._fd;
            this.remoteAddress = socket.remoteAddress;
            this.remotePort = socket.remotePort;
        }
        this._tlsOptions = options || {};
        this._upgraded = false;
    }

    _upgrade() {
        if (!tlsAvailable()) {
            const err = errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
                "tls requires an OpenSSL build (make TLS=openssl)");
            this.emit("error", err);
            return false;
        }
        const tls = skynetcore.tls;
        tls.init();
        const ctx = tls.ctxNew(false);
        tls.ctxSetVerify(ctx, this._tlsOptions.ca);
        const session = tls.newtls("client", ctx, this.servername);
        this._tlsSession = session;
        this._tlsCtx = ctx;
        this._upgraded = true;
        this.authorized = true;
        this.emit("secureConnect");
        return true;
    }

    end(data, encoding, callback) {
        if (this._upgraded) {
            try { skynetcore.tls.close(this._tlsSession); } catch (_) { /* ignore */ }
        }
        return super.end(data, encoding, callback);
    }
}

function connect(port, host, options, listener) {
    if (typeof host === "function") { listener = host; host = undefined; }
    else if (typeof options === "function") { listener = options; options = undefined; }
    else if (typeof port === "object" && port !== null) {
        options = port; host = options.host; port = options.port;
    }
    const socket = new TLSSocket(null, Object.assign({}, options, { host, port }));
    if (typeof listener === "function") socket.once("secureConnect", listener);
    if (!tlsAvailable()) {
        queueMicrotask(() => socket.emit("error",
            errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
                "tls requires an OpenSSL build (make TLS=openssl)")));
        return socket;
    }
    net.Socket.prototype.connect.call(socket, port, host, () => {
        socket._upgrade();
    });
    return socket;
}

function createServer(options, connectionListener) {
    const server = new net.Server(options, connectionListener);
    server.on("connection", (socket) => {
        if (!tlsAvailable()) {
            socket.emit("error", errors.skyjsError("ERR_UNSUPPORTED_PLATFORM",
                "tls requires an OpenSSL build (make TLS=openssl)"));
            return;
        }
        const tls = skynetcore.tls;
        tls.init();
        const ctx = tls.ctxNew(true);
        if (options && options.cert && options.key) {
            tls.ctxSetCert(ctx, options.cert, options.key);
        }
        const session = tls.newtls("server", ctx, undefined);
        socket._tlsSession = session;
        socket._tlsCtx = ctx;
        socket.authorized = true;
        server.emit("secureConnection", socket);
    });
    return server;
}

const rootCertificates = [];
const DEFAULT_MIN_VERSION = "TLSv1.2";
const DEFAULT_MAX_VERSION = "TLSv1.3";

module.exports = {
    TLSSocket,
    connect,
    createServer,
    createSecureContext: (options) => ({ context: options || {} }),
    rootCertificates,
    DEFAULT_MIN_VERSION,
    DEFAULT_MAX_VERSION,
};
