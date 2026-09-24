"use strict";

// Node EventEmitter subset used by the engine's own facades. Kept dependency
// free so it can be loaded both as a builtin and by test/unit under Node.

const kEvents = Symbol("skyjs.events");
const kMaxListeners = Symbol("skyjs.maxListeners");

function checkListener(listener) {
    if (typeof listener !== "function") {
        throw new TypeError("The listener must be a function");
    }
}

class EventEmitter {
    constructor() {
        this[kEvents] = new Map();
        this[kMaxListeners] = 10;
    }

    static listenerCount(emitter, event) {
        return emitter.listenerCount(event);
    }

    static getEventListeners(emitter, event) {
        return emitter.listeners(event);
    }

    static get defaultMaxListeners() {
        return 10;
    }

    static set defaultMaxListeners(value) {
        if (!Number.isInteger(value) || value < 0) {
            throw new RangeError("defaultMaxListeners must be a non-negative integer");
        }
    }

    setMaxListeners(n) {
        if (!Number.isInteger(n) || n < 0) {
            throw new RangeError("setMaxListeners must be a non-negative integer");
        }
        this[kMaxListeners] = n;
        return this;
    }

    getMaxListeners() {
        return this[kMaxListeners];
    }

    _list(event, create) {
        let list = this[kEvents].get(event);
        if (!list && create) {
            list = [];
            this[kEvents].set(event, list);
        }
        return list;
    }

    addListener(event, listener) {
        return this.on(event, listener);
    }

    on(event, listener) {
        checkListener(listener);
        this._list(event, true).push(listener);
        return this;
    }

    prependListener(event, listener) {
        checkListener(listener);
        this._list(event, true).unshift(listener);
        return this;
    }

    once(event, listener) {
        checkListener(listener);
        const wrapper = (...args) => {
            this.removeListener(event, wrapper);
            listener.apply(this, args);
        };
        wrapper.listener = listener;
        return this.on(event, wrapper);
    }

    prependOnceListener(event, listener) {
        checkListener(listener);
        const wrapper = (...args) => {
            this.removeListener(event, wrapper);
            listener.apply(this, args);
        };
        wrapper.listener = listener;
        return this.prependListener(event, wrapper);
    }

    removeListener(event, listener) {
        const list = this._list(event, false);
        if (!list) return this;
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i] === listener || list[i].listener === listener) {
                list.splice(i, 1);
                break;
            }
        }
        if (list.length === 0) this[kEvents].delete(event);
        return this;
    }

    off(event, listener) {
        return this.removeListener(event, listener);
    }

    removeAllListeners(event) {
        if (event === undefined) this[kEvents].clear();
        else this[kEvents].delete(event);
        return this;
    }

    listeners(event) {
        return (this._list(event, false) || []).map((fn) =>
            fn.listener || fn);
    }

    rawListeners(event) {
        return (this._list(event, false) || []).slice();
    }

    listenerCount(event) {
        const list = this._list(event, false);
        return list ? list.length : 0;
    }

    eventNames() {
        return Array.from(this[kEvents].keys());
    }

    emit(event, ...args) {
        const list = this._list(event, false);
        if (!list || list.length === 0) return false;
        for (const listener of list.slice()) {
            listener.apply(this, args);
        }
        return true;
    }
}

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
