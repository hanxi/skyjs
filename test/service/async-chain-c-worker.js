// Async reentry acceptance: C asks D to call back into the waiting B service.
const dH = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/async-chain-d-worker.js");

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        const separator = msg.indexOf("|");
        if (separator <= 0) throw new Error("invalid C request: " + msg);
        const bH = Number(msg.slice(0, separator));
        const token = msg.slice(separator + 1);
        const r = await skynet.call(dH, "text", bH + "|" + token);
        return "C(" + r + ")";
    });
});
