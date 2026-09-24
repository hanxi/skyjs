"use strict";

// Private C<->JS routing hooks. Kept separate from the public `skynet` object
// so the runtime can register socket/cluster handlers without exposing them.

let socketHandler = null;
let clusterResponseHandler = null;
let clusterErrorHandler = null;

function setSocketHandler(handler) {
    socketHandler = handler;
}

function getSocketHandler() {
    return socketHandler;
}

function setClusterHandlers(response, error) {
    clusterResponseHandler = response;
    clusterErrorHandler = error;
}

function getClusterHandlers() {
    return {
        response: clusterResponseHandler,
        error: clusterErrorHandler,
    };
}

module.exports = {
    setSocketHandler,
    getSocketHandler,
    setClusterHandlers,
    getClusterHandlers,
};
