// NC0.1 acceptance: smoke-test the runtime primitives and the initial
// skynet.features() surface. Full capability reporting lands in NC0.3.
(function () {
    "use strict";

    const info = skynetcore.runtime.info();
    const features = skynet.features();
    const argv = skynetcore.runtime.argv();
    const hrtime = skynetcore.runtime.hrtime();
    const environ = skynetcore.runtime.environ();

    if (typeof info !== "object" || info === null) {
        throw new Error("runtime.info() did not return an object");
    }
    if (info.version !== features.version) {
        throw new Error("runtime/info version mismatch: " + info.version +
            " != " + features.version);
    }
    if (!["darwin", "linux"].includes(info.platform)) {
        throw new Error("unexpected runtime platform: " + info.platform);
    }
    if (!["arm64", "x64"].includes(info.arch)) {
        throw new Error("unexpected runtime arch: " + info.arch);
    }
    if (typeof info.pid !== "number" || info.pid <= 0) {
        throw new Error("runtime.info().pid is invalid");
    }
    if (typeof info.ppid !== "number" || info.ppid < 0) {
        throw new Error("runtime.info().ppid is invalid");
    }
    if (typeof info.execPath !== "string" || info.execPath.length === 0) {
        throw new Error("runtime.info().execPath is invalid");
    }
    if (typeof info.uptime !== "number" || info.uptime < 0) {
        throw new Error("runtime.info().uptime is invalid");
    }
    if (!Array.isArray(argv) || argv.length < 2 ||
            argv[1] !== "test/service/features-main.js") {
        throw new Error("runtime.argv() is invalid: " + JSON.stringify(argv));
    }
    if (typeof argv[0] !== "string" || argv[0].length === 0) {
        throw new Error("runtime.argv()[0] is invalid");
    }
    if (!Array.isArray(hrtime) || hrtime.length !== 2 ||
            !Number.isSafeInteger(hrtime[0]) || !Number.isSafeInteger(hrtime[1]) ||
            hrtime[0] < 0 || hrtime[1] < 0 || hrtime[1] > 999999999) {
        throw new Error("runtime.hrtime() is invalid");
    }
    if (typeof environ !== "object" || environ === null ||
            typeof environ.PATH !== "string") {
        throw new Error("runtime.environ() did not expose PATH");
    }

    skynetcore.error("FEATURES_OK version=" + features.version +
        " platform=" + info.platform + " arch=" + info.arch);
})();

skynet.start(() => {
    skynet.dispatch("text", (msg) => "FEATURES:" + msg);
});
