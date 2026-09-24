// console.* acceptance: every level maps to the skynet log channel; values
// beyond strings are rendered recursively (Maps as entries, BigInt with "n",
// binary as length/hex summaries). The tail block covers the format/timer
// surface: printf-style placeholders (%s %d %f %j %o %%), time/timeLog/
// timeEnd, and the missing-label warning. Assertions live in tools/
// run-tests.js (console scenario).
console.log("log", 1, 1.5, true, null, undefined, 10n);
console.info("info", [1, 2], new Map([[1, "a"], ["k", 5n]]));
console.warn("warn", { k: "v", nested: { x: 1 } });
console.error("error", new Uint8Array([1, 2, 3]), new ArrayBuffer(4));
console.debug("debug", "tail");
console.trace("trace", function named() {});
console.log("FMT [%s] [%d] [%d] [%f] [%j] [%o] [%%]", "s", 7, 3.9, 1.25, { k: 1 }, [2, 3]);
console.log("FMT missing [%d] trailing", 1, "extra");
console.time("T");
console.timeLog("T");
console.timeEnd("T");
console.timeEnd("NOPE");
skynetcore.runtime.error("CONSOLE_OK");
skynet.register("main");

skynet.start(() => {
    skynet.dispatch("text", (msg) => "OK:" + msg);
});
