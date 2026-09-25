"use strict";

// NC4.4 acceptance: require('crypto') + require('zlib') over the C kernel.

const testing = require("skyjs/testing");
const crypto = require("crypto");
const zlib = require("zlib");

skynet.timeout(1, async () => {
    // crypto: hash / hmac / random
    const sha = crypto.createHash("sha256").update("abc").digest("hex");
    testing.equal(sha,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "sha256 known vector");
    const hmac = crypto.createHmac("sha256", "key").update("data").digest("hex");
    testing.equal(hmac.length, 64, "hmac length");
    testing.equal(crypto.randomBytes(16).length, 16, "randomBytes");
    const uuid = crypto.randomUUID();
    testing.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid),
        "randomUUID v4 shape");
    testing.ok(crypto.timingSafeEqual(Buffer.from("abc"), Buffer.from("abc")), "timingSafeEqual");
    testing.ok(crypto.getHashes().includes("sha256"), "getHashes");

    // zlib: deflate/inflate + gzip
    const payload = Buffer.from("compress me ".repeat(200));
    const deflated = zlib.deflateSync(payload);
    testing.ok(deflated.length < payload.length, "deflate shrinks repeated data");
    testing.equal(zlib.inflateSync(deflated).toString(), payload.toString(), "inflate round-trip");

    const gz = zlib.gzipSync(payload);
    testing.equal(gz[0], 0x1f, "gzip magic 1");
    testing.equal(gz[1], 0x8b, "gzip magic 2");
    testing.equal(zlib.gunzipSync(gz).toString(), payload.toString(), "gunzip round-trip");

    const asyncDeflated = await zlib.deflate(payload);
    testing.equal(zlib.inflateSync(asyncDeflated).toString(), payload.toString(),
        "async deflate round-trip");

    skynetcore.runtime.error("CRYPTO_NODE_OK hash=1 hmac=1 random=1 zlib=1 checks=" +
        testing.summary().checks);
});

skynet.start(() => {
    skynet.dispatch("text", (msg) => "CRYPTO_NODE:" + msg);
});
