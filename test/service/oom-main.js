// Task 2 acceptance: bootstrap for the OOM scenario.
const h = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/oom-worker.js");
skynetcore.runtime.error("MAIN oom_worker handle = " + h);
skynetcore.runtime.intCommand("LAUNCH", "driver " + h + " 300 oom 0");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK";
};
