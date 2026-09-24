// Task 8 acceptance: crypto module tests. Runs all crypt.* functions with
// known test vectors and prints CRYPT <name> OK / CRYPT FAIL markers.
"use strict";

const crypt = require("../../js/internal/crypt-core.js");

let failCount = 0;

function hex(ab) {
    return crypt.hexEncode(ab);
}

function abEq(a, b) {
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    if (va.length !== vb.length) return false;
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
    }
    return true;
}

function check(label, ok, detail) {
    if (ok) {
        console.log("CRYPT " + label + " OK");
    } else {
        console.log("CRYPT FAIL " + label + (detail ? ": " + detail : ""));
        failCount++;
    }
}

function checkHex(label, ab, expected) {
    const got = hex(ab);
    check(label, got === expected, "got " + got + " expected " + expected);
}

skynet.start(() => {
    // ---- SHA family ----
    checkHex("sha1_abc",
        crypt.sha1("abc"),
        "a9993e364706816aba3e25717850c26c9cd0d89d");
    checkHex("sha1_empty",
        crypt.sha1(""),
        "da39a3ee5e6b4b0d3255bfef95601890afd80709");

    checkHex("sha256_abc",
        crypt.sha256("abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    checkHex("sha256_empty",
        crypt.sha256(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

    checkHex("sha512_abc",
        crypt.sha512("abc"),
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a" +
        "2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
    checkHex("sha512_empty",
        crypt.sha512(""),
        "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
        "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e");

    // ---- HMAC family (RFC 4231 Test Case 2: key="Jefe") ----
    const hmacData = "what do ya want for nothing?";
    checkHex("hmac_sha1",
        crypt.hmacSha1("Jefe", hmacData),
        "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    checkHex("hmac_sha256",
        crypt.hmacSha256("Jefe", hmacData),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    checkHex("hmac_sha512",
        crypt.hmacSha512("Jefe", hmacData),
        "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554" +
        "9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737");

    // ---- Base64 ----
    const b64Enc = crypt.base64Encode("abc");
    check("base64_encode", b64Enc === "YWJj", "got " + b64Enc);

    const b64Dec = crypt.base64Decode("YWJj");
    check("base64_decode", hex(b64Dec) === "616263", "got " + hex(b64Dec));

    // roundtrip
    const b64Input = "Hello, SkyJS crypto!";
    const b64Rt = crypt.base64Decode(crypt.base64Encode(b64Input));
    const b64RtStr = new TextDecoder().decode(new Uint8Array(b64Rt));
    check("base64_roundtrip", b64RtStr === b64Input, "got " + b64RtStr);

    // ---- Hex ----
    const hexEnc = crypt.hexEncode(new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer);
    check("hex_encode", hexEnc === "deadbeef", "got " + hexEnc);

    const hexDec = crypt.hexDecode("deadbeef");
    check("hex_decode", hex(hexDec) === "deadbeef", "got " + hex(hexDec));

    // roundtrip
    const hexInput = new Uint8Array([0, 1, 127, 128, 255]);
    const hexRt = crypt.hexDecode(crypt.hexEncode(hexInput.buffer));
    check("hex_roundtrip", abEq(hexInput.buffer, hexRt), "mismatch");

    // ---- DES ----
    // roundtrip with ISO7816-4 padding (default)
    const desKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    const desPlain = "test1234extra";
    const desEnc = crypt.desEncode(desKey, desPlain);
    const desDec = crypt.desDecode(desKey, desEnc);
    const desDecStr = new TextDecoder().decode(new Uint8Array(desDec));
    check("des_iso7816", desDecStr === desPlain, "got " + desDecStr);

    // roundtrip with PKCS7 padding
    const desEncP7 = crypt.desEncode(desKey, desPlain, crypt.padding.pkcs7);
    const desDecP7 = crypt.desDecode(desKey, desEncP7, crypt.padding.pkcs7);
    const desDecP7Str = new TextDecoder().decode(new Uint8Array(desDecP7));
    check("des_pkcs7", desDecP7Str === desPlain, "got " + desDecP7Str);

    // ---- DH key exchange ----
    const aPriv = crypt.randomkey();
    const bPriv = crypt.randomkey();
    const aPub = crypt.dhExchange(aPriv);
    const bPub = crypt.dhExchange(bPriv);
    const sharedA = crypt.dhSecret(bPub, aPriv);
    const sharedB = crypt.dhSecret(aPub, bPriv);
    check("dh_exchange", hex(sharedA) === hex(sharedB),
        "A=" + hex(sharedA) + " B=" + hex(sharedB));

    // ---- XOR ----
    const xorOrig = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    const xorOrigHex = hex(xorOrig.buffer);
    const xorData = xorOrig.buffer.slice(0);   // copy
    const xorKey = new Uint8Array([0xAB, 0xCD]).buffer;
    crypt.xorStr(xorData, xorKey);
    const xorMid = hex(xorData);
    check("xor_changed", xorMid !== xorOrigHex, "XOR did not change data");
    crypt.xorStr(xorData, xorKey);
    check("xor_roundtrip", hex(xorData) === xorOrigHex,
        "got " + hex(xorData) + " expected " + xorOrigHex);

    // ---- Random ----
    const rb = crypt.randomBytes(32);
    check("random_bytes_len", rb.byteLength === 32, "len=" + rb.byteLength);
    const rbV = new Uint8Array(rb);
    let rbNonzero = false;
    for (let i = 0; i < rbV.length; i++) {
        if (rbV[i] !== 0) { rbNonzero = true; break; }
    }
    check("random_bytes_nonzero", rbNonzero, "all zeros");

    const rk = crypt.randomkey();
    check("randomkey_len", rk.byteLength === 8, "len=" + rk.byteLength);
    const rkV = new Uint8Array(rk);
    let rkXor = 0;
    for (let i = 0; i < rkV.length; i++) rkXor ^= rkV[i];
    check("randomkey_nonzero", rkXor !== 0 || rkV[0] !== 0, "all-zero XOR");

    // ---- AES-GCM (OpenSSL only — SKIP if unavailable) ----
    try {
        const aesKey = crypt.randomBytes(32);
        const aesIv = crypt.randomBytes(12);
        const aesPlain = "hello aes-gcm";
        const encResult = crypt.aesGcmEncrypt(aesKey, aesPlain, aesIv);
        const aesCt = encResult.ciphertext;
        const aesTag = encResult.tag;
        const aesDec = crypt.aesGcmDecrypt(aesKey, aesCt, aesIv, aesTag);
        const aesDecStr = new TextDecoder().decode(new Uint8Array(aesDec));
        check("aes_gcm", aesDecStr === aesPlain, "got " + aesDecStr);
        // tag tampering
        const badTag = new Uint8Array(aesTag);
        badTag[0] ^= 0xff;
        let tamperOk = false;
        try {
            crypt.aesGcmDecrypt(aesKey, aesCt, aesIv, badTag.buffer);
        } catch (e) {
            tamperOk = true;
        }
        check("aes_gcm_tamper", tamperOk, "tampered tag accepted");
    } catch (e) {
        if (e && e.message && e.message.includes("OpenSSL")) {
            console.log("CRYPT aes_gcm SKIP");
        } else {
            console.log("CRYPT FAIL aes_gcm: " + (e && e.message));
            failCount++;
        }
    }

    // ---- Ed25519 (OpenSSL only — SKIP if unavailable) ----
    try {
        const kp = crypt.ed25519Keypair();
        const edMsg = "sign me";
        const sig = crypt.ed25519Sign(kp.secretKey, edMsg);
        const ok1 = crypt.ed25519Verify(kp.publicKey, edMsg, sig);
        check("ed25519_sign_verify", ok1, "verify returned false");
        const ok2 = crypt.ed25519Verify(kp.publicKey, "tampered", sig);
        check("ed25519_tamper", !ok2, "tampered message verified true");
    } catch (e) {
        if (e && e.message && e.message.includes("OpenSSL")) {
            console.log("CRYPT ed25519 SKIP");
        } else {
            console.log("CRYPT FAIL ed25519: " + (e && e.message));
            failCount++;
        }
    }

    // ---- X25519 (OpenSSL only — SKIP if unavailable) ----
    try {
        const kpA = crypt.x25519Keypair();
        const kpB = crypt.x25519Keypair();
        const sA = crypt.x25519Shared(kpA.secretKey, kpB.publicKey);
        const sB = crypt.x25519Shared(kpB.secretKey, kpA.publicKey);
        check("x25519", hex(sA) === hex(sB),
            "A=" + hex(sA) + " B=" + hex(sB));
    } catch (e) {
        if (e && e.message && e.message.includes("OpenSSL")) {
            console.log("CRYPT x25519 SKIP");
        } else {
            console.log("CRYPT FAIL x25519: " + (e && e.message));
            failCount++;
        }
    }

    // ---- summary ----
    if (failCount === 0) {
        console.log("CRYPT ALL OK");
    } else {
        console.log("CRYPT FAIL total=" + failCount);
    }
});
