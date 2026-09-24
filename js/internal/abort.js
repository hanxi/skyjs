"use strict";

// WHATWG AbortController/AbortSignal subset. Event dispatch stays synchronous;
// AbortSignal is an EventTarget with the Node/WHATWG abort surface used by the
// runtime facades.

const kListeners = Symbol("skyjs.abort.listeners");
const kAborted = Symbol("skyjs.abort.aborted");
const kReason = Symbol("skyjs.abort.reason");

function createAbortError() {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    err.code = "ABORT_ERR";
    return err;
}

function createTimeoutError() {
    const err = new Error("The operation timed out");
    err.name = "TimeoutError";
    err.code = "ERR_TIMEOUT";
    return err;
}

class AbortSignal {
    constructor() {
        this[kListeners] = new Map();
        this[kAborted] = false;
        this[kReason] = undefined;
        this.onabort = null;
    }

    get aborted() {
        return this[kAborted];
    }

    get reason() {
        return this[kReason];
    }

    throwIfAborted() {
        if (this[kAborted]) throw this[kReason];
    }

    addEventListener(type, listener) {
        if (type !== "abort" || listener === null || listener === undefined) return;
        const callback = typeof listener === "function" ? listener : listener.handleEvent;
        if (typeof callback !== "function") return;
        if (!this[kListeners].has(type)) this[kListeners].set(type, []);
        this[kListeners].get(type).push({
            callback,
            once: typeof listener === "object" && listener.once === true,
        });
    }

    removeEventListener(type, listener) {
        const list = this[kListeners].get(type);
        if (!list) return;
        const callback = typeof listener === "function" ? listener : listener && listener.handleEvent;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].callback === callback) list.splice(i, 1);
        }
    }

    dispatchEvent(event) {
        const type = event && event.type ? event.type : "abort";
        const list = this[kListeners].get(type);
        if (list) {
            for (const item of list.slice()) {
                if (item.once) this.removeEventListener(type, item.callback);
                item.callback.call(this, event);
            }
        }
        if (type === "abort" && typeof this.onabort === "function") {
            this.onabort.call(this, event);
        }
        return true;
    }

    static abort(reason) {
        const controller = new AbortController();
        controller.abort(reason);
        return controller.signal;
    }

    static timeout(ms) {
        const controller = new AbortController();
        setTimeout(() => controller.abort(createTimeoutError()), ms);
        return controller.signal;
    }
}

// Primitives cannot run user JS while the C side is executing, so abort()
// performs the (synchronous) listener dispatch here; the runtime tick
// afterwards drains any Promise continuations registered by those listeners.
class AbortController {
    constructor() {
        this.signal = new AbortSignal();
    }

    abort(reason) {
        if (this.signal[kAborted]) return;
        this.signal[kAborted] = true;
        this.signal[kReason] = reason === undefined ?
            createAbortError() : reason;
        const event = { type: "abort", target: this.signal };
        this.signal.dispatchEvent(event);
    }
}

function install() {
    if (globalThis.AbortController === undefined) {
        globalThis.AbortController = AbortController;
    }
    if (globalThis.AbortSignal === undefined) {
        globalThis.AbortSignal = AbortSignal;
    }
}

module.exports = {
    AbortController,
    AbortSignal,
    createAbortError,
    createTimeoutError,
    install,
};
