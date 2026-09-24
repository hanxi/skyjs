// Task 3 acceptance: chain hop A. Awaits a call to chain_b before replying.
const bH = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/async-chain-b-worker.js");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const r = await skynet.call(bH, "text", msg + "->B");
        return "A(" + r + ")";
    });
});
