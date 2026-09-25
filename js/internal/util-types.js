"use strict";

// util.types predicates (Node-compatible subset).

const toString = Object.prototype.toString;

function tag(value) {
    return toString.call(value);
}

function isAnyArrayBuffer(value) {
    return tag(value) === "[object ArrayBuffer]" ||
        (typeof SharedArrayBuffer !== "undefined" &&
            tag(value) === "[object SharedArrayBuffer]");
}

function isArrayBufferView(value) {
    return ArrayBuffer.isView(value);
}

const typedArrayTypes = {
    Int8Array: true, Uint8Array: true, Uint8ClampedArray: true,
    Int16Array: true, Uint16Array: true, Int32Array: true, Uint32Array: true,
    Float32Array: true, Float64Array: true, BigInt64Array: true,
    BigUint64Array: true, DataView: true,
};

function isTypedArray(value) {
    return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

module.exports = {
    isAnyArrayBuffer,
    isArrayBufferView,
    isArgumentsObject: (v) => tag(v) === "[object Arguments]",
    isArrayBuffer: (v) => tag(v) === "[object ArrayBuffer]",
    isAsyncFunction: (v) => tag(v) === "[object AsyncFunction]",
    isBigInt64Array: (v) => tag(v) === "[object BigInt64Array]",
    isBigUint64Array: (v) => tag(v) === "[object BigUint64Array]",
    isBooleanObject: (v) => tag(v) === "[object Boolean]",
    isBoxedPrimitive: (v) => tag(v) === "[object Boolean]" ||
        tag(v) === "[object Number]" || tag(v) === "[object String]" ||
        tag(v) === "[object Symbol]" || tag(v) === "[object BigInt]",
    isDate: (v) => tag(v) === "[object Date]",
    isExternal: () => false,
    isFloat32Array: (v) => tag(v) === "[object Float32Array]",
    isFloat64Array: (v) => tag(v) === "[object Float64Array]",
    isGeneratorFunction: (v) => tag(v) === "[object GeneratorFunction]",
    isGeneratorObject: (v) => tag(v) === "[object Generator]",
    isInt8Array: (v) => tag(v) === "[object Int8Array]",
    isInt16Array: (v) => tag(v) === "[object Int16Array]",
    isInt32Array: (v) => tag(v) === "[object Int32Array]",
    isMap: (v) => tag(v) === "[object Map]",
    isMapIterator: (v) => tag(v) === "[object Map Iterator]",
    isModuleNamespaceObject: (v) => tag(v) === "[object Module]",
    isNativeError: (v) => v instanceof Error,
    isNumberObject: (v) => tag(v) === "[object Number]",
    isPromise: (v) => v instanceof Promise || tag(v) === "[object Promise]",
    isProxy: () => false,
    isRegExp: (v) => tag(v) === "[object RegExp]",
    isSet: (v) => tag(v) === "[object Set]",
    isSetIterator: (v) => tag(v) === "[object Set Iterator]",
    isSharedArrayBuffer: (v) => tag(v) === "[object SharedArrayBuffer]",
    isStringObject: (v) => tag(v) === "[object String]",
    isSymbolObject: (v) => tag(v) === "[object Symbol]",
    isTypedArray,
    isUint8Array: (v) => tag(v) === "[object Uint8Array]",
    isUint8ClampedArray: (v) => tag(v) === "[object Uint8ClampedArray]",
    isUint16Array: (v) => tag(v) === "[object Uint16Array]",
    isUint32Array: (v) => tag(v) === "[object Uint32Array]",
    isWeakMap: (v) => tag(v) === "[object WeakMap]",
    isWeakSet: (v) => tag(v) === "[object WeakSet]",
    isArrayBufferViewAny: isArrayBufferView,
};
