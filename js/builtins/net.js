"use strict";

// Node `net` facade: Socket / Server / connect / listen + timeout, built on the
// merged internal/net-core (connection lifecycle + buffered reader) with the
// "keep-alive + event pump" adaptation the Actor model needs (§15.4).

const { EventEmitter } = require("./events.js");
const netCore = require("../internal/net-core.js");
const errors = require("../internal/errors.js");

const DEFAULT_TIMEOUT = 0;

class Socket extends EventEmitter {
    constructor(options) {
        super();
        const opts = options || {};
        this.connecting = false;
        this.destroyed = false;
        this.remoteAddress = opts.host || "";
        this.remotePort = opts.port || 0;
        this._fd = -1;
        this._timeout = DEFAULT_TIMEOUT;
        this._timeoutId = null;
        this._onData = null;
    }

    connect(port, host, listener) {
        let options;
        if (typeof port === "object" && port !== null) {
            options = port;
            listener = host;
        } else {
            options = { port, host };
        }
        if (typeof listener === "function") this.once("connect", listener);
        this.remotePort = options.port | 0;
        this.remoteAddress = options.host || "127.0.0.1";
        this.connecting = true;
        const fd = netCore.connect(this.remoteAddress, this.remotePort, () => {
            this.connecting = false;
            this._fd = fd;
            this.id = fd;
            this.emit("connect");
            this._armTimeout();
            this._pump();
        });
        if (fd < 0) {
            const err = errors.skyjsError("ERR_IO",
                "connect failed: " + this.remoteAddress + ":" + this.remotePort);
            queueMicrotask(() => this.emit("error", err));
        }
        return this;
    }

    _armTimeout() {
        if (this._timeout <= 0) return;
        this._timeoutId = setTimeout(() => {
            const err = errors.skyjsError("ERR_TIMEOUT", "socket timeout");
            this.emit("timeout");
            this.destroy(err);
        }, this._timeout);
    }

    _refreshTimeout() {
        if (this._timeoutId !== null) clearTimeout(this._timeoutId);
        this._armTimeout();
    }

    _pump() {
        netCore.start(this._fd, (data) => {
            this._refreshTimeout();
            const chunk = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(String(data));
            this.emit("data", chunk);
            if (this._onData) this._onData(chunk);
        }, () => {
            this.emit("end");
            this.emit("close", false);
            this.destroyed = true;
        }, (_id, message) => {
            this.emit("error", errors.skyjsError("ERR_IO", "socket error: " + message));
        }, { binary: true });
        netCore.resume(this._fd);
    }

    write(data, encoding, callback) {
        const cb = typeof encoding === "function" ? encoding : callback;
        if (this.destroyed) {
            const err = errors.skyjsError("ERR_IO", "write after destroy");
            if (cb) cb(err); else this.emit("error", err);
            return false;
        }
        this._refreshTimeout();
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding);
        const n = netCore.write(this._fd, payload);
        if (cb) cb();
        return n >= 0;
    }

    end(data, encoding, callback) {
        if (data !== undefined && data !== null) this.write(data, encoding);
        this.emit("finish");
        // SkyJS sockets close rather than half-close by default.
        this.destroy();
        const cb = typeof encoding === "function" ? encoding : callback;
        if (cb) cb();
        return this;
    }

    setTimeout(ms, listener) {
        this._timeout = ms | 0;
        if (typeof listener === "function") this.once("timeout", listener);
        this._refreshTimeout();
        return this;
    }

    setNoDelay(on) {
        if (on !== false && typeof netCore.nodelay === "function") {
            netCore.nodelay(this._fd);
        }
        return this;
    }

    setKeepAlive() {
        return this;
    }

    address() {
        return { address: this.remoteAddress, family: "IPv4", port: this.remotePort };
    }

    destroy(err) {
        if (this.destroyed) return this;
        this.destroyed = true;
        if (this._timeoutId !== null) { clearTimeout(this._timeoutId); this._timeoutId = null; }
        try { netCore.close(this._fd); } catch (_) { /* ignore */ }
        if (err) this.emit("error", err);
        this.emit("close", !!err);
        return this;
    }

    ref() { return this; }
    unref() { return this; }

    static connect(...args) {
        const socket = new Socket();
        return socket.connect(...args);
    }
}

class Server extends EventEmitter {
    constructor(options, connectionListener) {
        super();
        const opts = typeof options === "function" ? {} : (options || {});
        this.listening = false;
        this.maxConnections = opts.maxConnections || undefined;
        this._fd = -1;
        this._connections = 0;
        if (typeof options === "function") this.on("connection", options);
        if (typeof connectionListener === "function") this.on("connection", connectionListener);
    }

    listen(...args) {
        const callback = typeof args[args.length - 1] === "function" ? args.pop() : null;
        let options;
        if (typeof args[0] === "object" && args[0] !== null) options = args[0];
        else if (typeof args[0] === "number") options = { port: args[0], host: args[1] };
        else options = {};
        if (callback) this.once("listening", callback);

        this._fd = netCore.listen(options.host || "0.0.0.0",
            options.port | 0, (connId, addr) => {
                const socket = new Socket();
                socket._fd = connId;
                socket.id = connId;
                socket.remoteAddress = addr || "";
                this._connections++;
                this.emit("connection", socket);
                socket._pump();
            }, options.backlog || 64);
        this.listening = this._fd >= 0;
        queueMicrotask(() => this.emit("listening"));
        return this;
    }

    address() {
        return { address: "0.0.0.0", family: "IPv4", port: 0 };
    }

    close(callback) {
        if (callback) this.once("close", callback);
        try { netCore.close(this._fd); } catch (_) { /* ignore */ }
        this.listening = false;
        this.emit("close");
        return this;
    }

    getConnections(callback) {
        if (callback) callback(null, this._connections);
        return this._connections;
    }
}

function createServer(options, connectionListener) {
    return new Server(options, connectionListener);
}

function connect(...args) {
    return Socket.connect(...args);
}

function createConnection(...args) {
    return Socket.connect(...args);
}

const isIP = (value) => /^[0-9.]+$/.test(String(value)) ? 4 : 0;
const isIPv4 = (value) => isIP(value) === 4;
const isIPv6 = () => false;

module.exports = {
    Socket,
    Server,
    createServer,
    connect,
    createConnection,
    isIP,
    isIPv4,
    isIPv6,
};
