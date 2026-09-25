"use strict";

// Only the Node-portable parts of `os` are compared here (tmpdir/homedir/user
// depend on the host environ, which differs by design).
module.exports.run = function () {
    const os = require("os");
    return {
        EOL: os.EOL,
        endianness: os.endianness(),
        errno: {
            ENOENT: os.constants.errno.ENOENT,
            EACCES: os.constants.errno.EACCES,
            EEXIST: os.constants.errno.EEXIST,
            EISDIR: os.constants.errno.EISDIR,
        },
        loadavgLength: os.loadavg().length,
        cpusIsArray: Array.isArray(os.cpus()),
        userInfoShape: Object.keys(os.userInfo()).sort(),
    };
};
