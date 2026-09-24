"use strict";

// Node-style event loop facade over skynet timers. The C host calls tick() at
// message boundaries; timers/immediates self-wake the actor with TIMEOUT(0).

const MIN_DELAY_MS = 10;
const MAX_DELAY_MS = 2147483647;

let installed = false;
let ticking = false;
let nextHandleId = 1;
let nextTickQueue = [];
let immediateQueue = [];
const timers = new Map();
let wakeGeneration = 0;
let wakeAt = Infinity;
let wakeId = null;

function nowMs() {
    return Date.now();
}

function reportCallbackError(prefix, err) {
    const detail = err && err.stack ? err.stack : String(err);
    skynetcore.runtime.error(prefix + ": " + detail);
}

function normalizeDelay(delay) {
    let value = Number(delay);
    if (!Number.isFinite(value) || value < 0) value = 0;
    if (value > MAX_DELAY_MS) value = MAX_DELAY_MS;
    return Math.max(MIN_DELAY_MS, Math.ceil(value));
}

function validateCallback(callback, name) {
    if (typeof callback !== "function") {
        throw new TypeError("The callback argument must be a function for " + name);
    }
}

class TimerHandle {
    constructor(callback, delay, args, repeat) {
        this._id = nextHandleId++;
        this._callback = callback;
        this._args = args;
        this._delay = normalizeDelay(delay);
        this._due = nowMs() + this._delay;
        this._repeat = repeat;
        this._ref = true;
        this._cancelled = false;
    }

    ref() {
        this._ref = true;
        scheduleWake();
        return this;
    }

    unref() {
        this._ref = false;
        return this;
    }

    hasRef() {
        return this._ref;
    }

    refresh() {
        if (!this._cancelled) {
            this._due = nowMs() + this._delay;
            scheduleWake();
        }
        return this;
    }
}

class ImmediateHandle {
    constructor(callback, args) {
        this._id = nextHandleId++;
        this._callback = callback;
        this._args = args;
        this._ref = true;
        this._cancelled = false;
    }

    ref() {
        this._ref = true;
        scheduleWake();
        return this;
    }

    unref() {
        this._ref = false;
        return this;
    }

    hasRef() {
        return this._ref;
    }
}

function drainNextTick() {
    while (nextTickQueue.length !== 0) {
        const queue = nextTickQueue;
        nextTickQueue = [];
        for (const item of queue) {
            try {
                item.callback(...item.args);
            } catch (err) {
                reportCallbackError("process.nextTick", err);
            }
        }
    }
}

function drainMicrotasks() {
    const drain = globalThis.__snjs_drain_jobs;
    if (typeof drain === "function") drain();
}

// nextTick wins over Promise microtasks at every check point. If a microtask
// queues another nextTick, that nextTick runs after the current microtask
// queue drains, and then any microtasks it queues are drained too.
function drainMicrotasksAndNextTick() {
    for (;;) {
        drainNextTick();
        drainMicrotasks();
        if (nextTickQueue.length === 0) return;
    }
}

function afterCallback() {
    drainMicrotasksAndNextTick();
}

function runTimer(handle) {
    if (handle._cancelled) return;
    if (handle._repeat) {
        handle._due = nowMs() + handle._delay;
    } else {
        timers.delete(handle._id);
    }
    try {
        handle._callback(...handle._args);
    } catch (err) {
        reportCallbackError("timer", err);
    }
    afterCallback();
}

function drainImmediates() {
    if (immediateQueue.length === 0) return;
    const queue = immediateQueue;
    immediateQueue = [];
    for (const handle of queue) {
        if (handle._cancelled) continue;
        try {
            handle._callback(...handle._args);
        } catch (err) {
            reportCallbackError("setImmediate", err);
        }
        afterCallback();
    }
}

function drainTimers() {
    const current = nowMs();
    const due = [];
    for (const handle of timers.values()) {
        if (!handle._cancelled && handle._due <= current) due.push(handle);
    }
    due.sort((a, b) => a._due - b._due || a._id - b._id);
    for (const handle of due) runTimer(handle);
}

function earliestWake() {
    let at = Infinity;
    for (const handle of immediateQueue) {
        if (!handle._cancelled && handle._ref) return { at: nowMs(), centiseconds: 0 };
    }
    for (const handle of timers.values()) {
        if (handle._cancelled || !handle._ref) continue;
        if (handle._due < at) at = handle._due;
    }
    if (at === Infinity) return null;
    const remaining = Math.max(0, at - nowMs());
    return { at, centiseconds: Math.max(1, Math.ceil(remaining / 10)) };
}

function scheduleWake() {
    const next = earliestWake();
    if (next === null) return;
    if (wakeId !== null && wakeAt <= next.at) return;

    wakeGeneration += 1;
    const generation = wakeGeneration;
    wakeAt = next.at;
    wakeId = skynet.timeout(next.centiseconds, function () {
        if (generation !== wakeGeneration) return;
        wakeId = null;
        wakeAt = Infinity;
        tick();
    });
}

function tick() {
    if (ticking) return;
    ticking = true;
    try {
        // The order is intentionally fixed: nextTick/microtask, then every
        // immediate queued at entry, then every timer due at entry. Callbacks
        // queued during those phases run at the next check point instead of
        // extending the current drain indefinitely.
        drainMicrotasksAndNextTick();
        drainImmediates();
        drainTimers();
    } finally {
        ticking = false;
    }
    scheduleWake();
}

function nextTick(callback, ...args) {
    validateCallback(callback, "process.nextTick");
    nextTickQueue.push({ callback, args });
}

function queueMicrotask(callback) {
    validateCallback(callback, "queueMicrotask");
    Promise.resolve().then(callback);
}

function setTimeout(callback, delay, ...args) {
    validateCallback(callback, "setTimeout");
    const handle = new TimerHandle(callback, delay, args, false);
    timers.set(handle._id, handle);
    scheduleWake();
    return handle;
}

function setInterval(callback, delay, ...args) {
    validateCallback(callback, "setInterval");
    const handle = new TimerHandle(callback, delay, args, true);
    timers.set(handle._id, handle);
    scheduleWake();
    return handle;
}

function clearTimer(handle) {
    if (handle && handle._cancelled === false) {
        handle._cancelled = true;
        timers.delete(handle._id);
    }
}

function setImmediate(callback, ...args) {
    validateCallback(callback, "setImmediate");
    const handle = new ImmediateHandle(callback, args);
    immediateQueue.push(handle);
    scheduleWake();
    return handle;
}

function clearImmediate(handle) {
    if (handle && handle._cancelled === false) {
        handle._cancelled = true;
    }
}

function install() {
    if (installed) return;
    installed = true;
    globalThis.setTimeout = setTimeout;
    globalThis.clearTimeout = clearTimer;
    globalThis.setInterval = setInterval;
    globalThis.clearInterval = clearTimer;
    globalThis.setImmediate = setImmediate;
    globalThis.clearImmediate = clearImmediate;
    globalThis.queueMicrotask = queueMicrotask;
    if (globalThis.process === undefined || globalThis.process === null) {
        globalThis.process = {};
    }
    globalThis.process.nextTick = nextTick;
}

module.exports = {
    install,
    tick,
    nextTick,
    queueMicrotask,
    setTimeout,
    clearTimeout: clearTimer,
    setInterval,
    clearInterval: clearTimer,
    setImmediate,
    clearImmediate,
};
