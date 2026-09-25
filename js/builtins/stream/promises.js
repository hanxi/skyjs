"use strict";

// `stream/promises`: promise forms of pipeline/finished.

const stream = require("./index.js");

function pipeline(...streams) {
    const callback = typeof streams[streams.length - 1] === "function" ?
        streams.pop() : null;
    return new Promise((resolve, reject) => {
        stream.pipeline(...streams, (err) => err ? reject(err) : resolve());
    }).then((value) => {
        if (callback) callback(null, value);
        return value;
    }, (err) => {
        if (callback) callback(err);
        throw err;
    });
}

function finished(streamInstance) {
    return new Promise((resolve, reject) => {
        stream.finished(streamInstance, (err) => err ? reject(err) : resolve());
    });
}

module.exports = { pipeline, finished };
