"use strict";

// NC5 acceptance: third-party C bridge dynamic loading via skyjs.native.

const testing = require("skyjs/testing");
const features = skynet.features();

skynet.timeout(1, () => {
    testing.equal(features.nativeExt.available, true, "nativeExt available");
    testing.equal(features.nativeExt.dynamic, true, "dynamic extpath configured");

    // require a package declaring skyjs.native -> loader dlopen + ABI check
    const example = require("@skyjs/example-native");
    testing.equal(example.hasNative, true, "module.native injected");
    testing.equal(example.abiProbe(), 1, "ABI probe via C bridge");

    // CRC32 known vector: "123456789" -> 0xCBF43926
    const input = Buffer.from("123456789");
    const crc = example.crc32(input.buffer.slice(input.byteOffset,
        input.byteOffset + input.byteLength));
    testing.equal(crc >>> 0, 0xcbf43926, "crc32 known vector");

    // skynetcore.native primitives are present and report honestly
    const native = skynetcore.native;
    testing.equal(native.enabled(), true, "native.enabled");
    testing.equal(native.staticEnabled(), false, "no static registry in this build");
    testing.ok(typeof native.errmsg() === "string", "native.errmsg");

    // resolve() rejects escapes out of the package root
    testing.equal(native.resolve("test/native-ext/example-native", "../escape.so"), null,
        "resolve denies ../ escape");
    testing.ok(native.resolve("test/native-ext/example-native",
        "libexample-native.dylib") !== null, "resolve accepts in-package path");

    skynetcore.runtime.error("NATIVE_EXT_OK load=1 abi=1 crc32=1 resolve=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "NATIVE_EXT:" + msg);
});
