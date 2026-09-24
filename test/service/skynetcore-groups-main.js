"use strict";

const failures = [];

function check(condition, message) {
    if (!condition) failures.push(message);
}

check(skynetcore.io === skynetcore.fs, "io/fs namespace identity");
check(skynetcore.socket === skynetcore.net, "socket/net namespace identity");
check(typeof skynetcore.net.listen === "function", "net.listen");
check(skynetcore.netpack.pack instanceof Function, "netpack.pack");
if (typeof skynetcore.pack === "function") {
    check(skynetcore.pack === skynetcore.seri.pack, "pack/seri identity");
    check(skynetcore.unpack === skynetcore.seri.unpack, "unpack/seri identity");
    check(skynetcore.str === skynetcore.seri.str, "str/seri identity");
}

const features = skynet.features();
check(features.version === skynet.version, "features version");
check(features.fsAsync.available === false, "fsAsync unavailable");
check(features.fsAsync.reason === "ERR_UNSUPPORTED_PLATFORM", "fsAsync reason");
check(features.httpStream.available === false, "httpStream unavailable");
check(features.httpStream.reason === "ERR_UNSUPPORTED_PLATFORM", "httpStream reason");
check(features.subprocess.available === false, "subprocess unavailable");
check(features.subprocess.reason === "ERR_UNSUPPORTED_PLATFORM", "subprocess reason");

if (failures.length !== 0) {
    throw new Error("SKYNETCORE_GROUPS_FAIL: " + failures.join("; "));
}

skynetcore.error("SKYNETCORE_GROUPS_OK fs=1 net=1 seri=1 features=1");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "GROUPS:" + msg);
});
