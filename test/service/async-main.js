// Task 3 acceptance: async core end-to-end.
// 1. JS -> C echo (await a reply from a C service)
// 2. chain A -> B (two JS services, nested awaits + timer)
// 3. reentry: B awaits C while D calls B; concurrent B handlers resume independently
// 4. dual call: B awaits two X sessions whose responses arrive in reverse order
// 5. concurrency: 10 interleaved sleep+call promises
// 6. error propagation: call async_bomb_worker -> PTYPE_ERROR -> reject -> catch
// The driver triggers "start" and logs the returned summary.

const echoH = skynetcore.runtime.intCommand("LAUNCH", "echo");
const chainH = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/async-chain-a-worker.js");
const bombH = skynetcore.runtime.intCommand("LAUNCH", "snjs test/service/async-bomb-worker.js");
skynetcore.runtime.error("MAIN echo=" + echoH + " chain=" + chainH + " bomb=" + bombH);
skynet.register("main");
skynetcore.runtime.intCommand("LAUNCH", "driver .main 300 start 0");

async function runTests() {
    const r1 = await skynet.call(echoH, "text", "ping");
    const r2 = await skynet.call(chainH, "text", "go");

    const reentryTokens = ["left", "right"];
    const reentryResults = await Promise.all(reentryTokens.map(token =>
        skynet.call(chainH, "text", "reentry:" + token)));
    for (let i = 0; i < reentryTokens.length; i++) {
        const expected = "A(B1(C(D(B2(" + reentryTokens[i] + ")))))";
        if (reentryResults[i] !== expected) {
            throw new Error("async reentry mismatch: expected " + expected +
                ", got " + reentryResults[i]);
        }
    }

    const dualResult = await skynet.call(chainH, "text", "dual:pair");
    const expectedDual = "A(BDUAL(X(pair-first),X(pair-second)))";
    if (dualResult !== expectedDual) {
        throw new Error("async dual mismatch: expected " + expectedDual + ", got " + dualResult);
    }

    const ps = [];
    for (let i = 0; i < 10; i++) {
        ps.push((async () => {
            await skynet.sleep(50 + i * 10);
            return await skynet.call(echoH, "text", "c" + i);
        })());
    }
    const rs = await Promise.all(ps);

    let errCaught = false;
    try {
        await skynet.call(bombH, "text", "boom");
    } catch (e) {
        errCaught = true;
    }

    const result = "R1=" + r1 + "|R2=" + r2 + "|REENTRY=" + reentryResults.join(",") +
        "|DUAL=" + dualResult + "|CONC=" + rs.join(",") + "|ERR=" + errCaught;
    skynetcore.runtime.error("ASYNC RESULT: " + result);
    return result;
}

skynet.start(() => {
    skynet.dispatch("text", async (msg) => {
        if (msg === "start") return await runTests();
        return "TEXT:" + msg;
    });
});
