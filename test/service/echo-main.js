// Task 2 acceptance: bootstrap script. Launches the JS echo service, then a
// C driver that calls it with "hello_from_js" after 300ms.
const h = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/echo-worker.js");
skynetcore.runtime.error("MAIN echo_worker handle = " + h);
skynetcore.runtime.intCommand("LAUNCH", "driver " + h + " 300 hello_from_js 0");

globalThis.dispatch = function (msg, session, source) {
    return "MAIN_OK:" + msg;
};
