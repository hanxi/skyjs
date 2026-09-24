"use strict";

let ok = true;
let finished = 0;

function fail(label) {
    ok = false;
    skynetcore.error("TIMERS_FAIL " + label);
}

function finish() {
    finished += 1;
    if (finished !== 3) return;
    if (ok) skynetcore.error("TIMERS_OK order=nextTick,nextTick2,promise,timer");
}

// 1. pure timer program: no external message drives the loop.
setTimeout(() => {
    finish();
}, 10);

// 2. immediate must beat an already-due timer.
const immediateOrder = [];
setImmediate(() => {
    immediateOrder.push("immediate");
    finish();
});
setTimeout(() => {
    immediateOrder.push("timer");
    if (immediateOrder.join(",") !== "immediate,timer") fail("immediate order");
    finish();
}, 0);

// 3. nextTick -> promise microtask -> timer.
const microOrder = [];
process.nextTick(() => {
    microOrder.push("nextTick");
    process.nextTick(() => microOrder.push("nextTick2"));
    Promise.resolve().then(() => {
        microOrder.push("promise");
        setTimeout(() => {
            microOrder.push("timer");
            if (microOrder.join(",") !== "nextTick,nextTick2,promise,timer") {
                fail("micro order: " + microOrder.join(","));
            }
            finish();
        }, 10);
    });
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "TIMERS:" + msg);
});
