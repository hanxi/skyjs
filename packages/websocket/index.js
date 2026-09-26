"use strict";

// @skyjs/websocket -- RFC 6455 server + client.
//
// Standalone package (node-compatibility §16.4.1): it depends only on the
// public `net` / `stream` / `crypto` / `tls` facades and never on js/internal/*,
// so it can ship and iterate independently of the engine.

module.exports = require("./lib/websocket.js");
