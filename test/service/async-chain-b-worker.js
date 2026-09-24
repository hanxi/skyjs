// Task 3 acceptance: chain hop B plus concurrent handler reentry.
const cH = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/async-chain-c-worker.js");
const xH = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/async-dual-worker.js");
const REENTRY_PREFIX = "reentry:";
const RESUME_PREFIX = "resume:";
const DUAL_PREFIX = "dual:";

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg.startsWith(REENTRY_PREFIX) && msg.endsWith("->B")) {
            const token = msg.slice(REENTRY_PREFIX.length, -3);
            const r = await skynet.call(cH, "text", skynet.self() + "|" + token);
            return "B1(" + r + ")";
        }
        if (msg.startsWith(RESUME_PREFIX)) {
            const token = msg.slice(RESUME_PREFIX.length);
            await skynet.sleep(10);
            return "B2(" + token + ")";
        }
        if (msg.startsWith(DUAL_PREFIX) && msg.endsWith("->B")) {
            const token = msg.slice(DUAL_PREFIX.length, -3);
            const firstPromise = skynet.call(xH, "text", "first|" + token + "-first");
            const secondPromise = skynet.call(xH, "text", "second|" + token + "-second");
            const second = await secondPromise;
            const first = await firstPromise;
            const expectedFirst = "X(" + token + "-first)";
            const expectedSecond = "X(" + token + "-second)";
            if (first !== expectedFirst || second !== expectedSecond) {
                throw new Error("dual call mismatch: " + first + "," + second);
            }
            return "BDUAL(" + first + "," + second + ")";
        }
        await skynet.sleep(200);
        return "B(" + msg + ")";
    });
});
