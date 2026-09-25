"use strict";

// NATIVE_EXT switch check. With NATIVE_EXT=0 skynetcore.native is absent and a
// package declaring skyjs.native must report ERR_UNSUPPORTED_PLATFORM.

const testing = require("skyjs/testing");
const features = skynet.features();

if (features.nativeExt.available === true) {
    testing.equal(typeof skynetcore.native, "object", "native namespace present when enabled");
    skynetcore.runtime.error("NATIVE_SWITCH_OK enabled=1 checks=" + testing.summary().checks);
} else {
    testing.equal(features.nativeExt.reason, "ERR_UNSUPPORTED_PLATFORM", "reason reported");
    let err = null;
    try { require("@skyjs/example-native"); } catch (e) { err = e; }
    testing.equal(err && err.code, "ERR_UNSUPPORTED_PLATFORM", "native package rejected");
    skynetcore.runtime.error("NATIVE_SWITCH_OK enabled=0 checks=" + testing.summary().checks);
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => "NATIVE_SWITCH:" + msg);
});
