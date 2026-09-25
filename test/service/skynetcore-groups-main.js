"use strict";

const failures = [];

function check(condition, message) {
    if (!condition) failures.push(message);
}

// NC0.8: legacy flat names are gone; only grouped namespaces remain.
check(skynetcore.io === undefined, "legacy io removed");
check(skynetcore.socket === undefined, "legacy socket removed");
check(skynetcore.pack === undefined, "legacy pack removed");
check(skynetcore.unpack === undefined, "legacy unpack removed");
check(skynetcore.str === undefined, "legacy str removed");
check(skynetcore.send === undefined, "legacy send removed");
check(skynetcore.error === undefined, "legacy error removed");

check(typeof skynetcore.runtime.send === "function", "runtime.send");
check(typeof skynetcore.runtime.error === "function", "runtime.error");
check(typeof skynetcore.runtime.intCommand === "function", "runtime.intCommand");
check(typeof skynetcore.fs.readFile === "function", "fs.readFile");
check(typeof skynetcore.net.listen === "function", "net.listen");
check(typeof skynetcore.seri.pack === "function", "seri.pack");
check(skynetcore.netpack.pack instanceof Function, "netpack.pack");

const packed = skynetcore.seri.pack({ value: 42 });
const roundTrip = skynetcore.seri.unpack(packed);
check(roundTrip.length === 1, "seri unpack arity");
check(roundTrip[0] instanceof LuaTable, "seri unpack returns LuaTable");
check(roundTrip[0].get("value") === 42, "seri round-trip");

const features = skynet.features();
check(features.version === skynet.version, "features version");
check(features.fsAsync.available === false, "fsAsync unavailable");
check(features.fsAsync.reason === "ERR_UNSUPPORTED_PLATFORM", "fsAsync reason");
check(features.httpStream.available === false, "httpStream unavailable");
check(features.httpStream.reason === "ERR_UNSUPPORTED_PLATFORM", "httpStream reason");
// SUBPROCESS=1 is the desktop default; the build switch is asserted by the
// subprocess scenario instead of hard-coding availability here.
check(typeof features.subprocess.available === "boolean", "subprocess reported");

if (failures.length !== 0) {
    throw new Error("SKYNETCORE_GROUPS_FAIL: " + failures.join("; "));
}

skynetcore.runtime.error("SKYNETCORE_GROUPS_OK fs=1 net=1 seri=1 features=1");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "GROUPS:" + msg);
});
