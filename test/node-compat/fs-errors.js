"use strict";

// Differential case: Node-shaped error fields for common fs failures.
module.exports.run = function () {
    const fs = require("fs");
    const missing = "/definitely/not/here-" + Date.now();
    const out = {};
    try {
        fs.readFileSync(missing);
    } catch (err) {
        out.readFileSync = {
            code: err.code,
            errno: err.errno,
            syscall: err.syscall,
            hasPath: typeof err.path === "string" && err.path === missing,
        };
    }
    try {
        fs.statSync(missing);
    } catch (err) {
        out.statSync = { code: err.code, syscall: err.syscall };
    }
    try {
        fs.readdirSync(missing);
    } catch (err) {
        out.readdirSync = { code: err.code, syscall: err.syscall };
    }
    return out;
};
