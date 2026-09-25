"use strict";

// Mobile-style builds set SUBPROCESS=0: features().subprocess must report
// unavailable and calling child_process must throw ERR_UNSUPPORTED_PLATFORM.
// Run with SUBPROCESS=0 to exercise the disabled path.

const testing = require("skyjs/testing");
const features = skynet.features();

if (features.subprocess.available === true) {
    // Enabled build: assert the opposite contract instead.
    testing.equal(features.subprocess.available, true, "subprocess available in desktop build");
    const cp = require("child_process");
    testing.ok(typeof cp.spawn === "function", "child_process exported when enabled");
    skynetcore.runtime.error("SUBPROCESS_SWITCH_OK enabled=1 checks=" + testing.summary().checks);
} else {
    testing.equal(features.subprocess.reason, "ERR_UNSUPPORTED_PLATFORM", "reason reported");
    let err = null;
    try { require("child_process").spawn("/bin/echo", ["x"]); } catch (e) { err = e; }
    testing.equal(err && err.code, "ERR_UNSUPPORTED_PLATFORM", "disabled build rejects");
    skynetcore.runtime.error("SUBPROCESS_SWITCH_OK enabled=0 checks=" + testing.summary().checks);
}

skynet.start(() => {
    skynet.dispatch("text", (msg) => "SUBPROCESS_SWITCH:" + msg);
});
