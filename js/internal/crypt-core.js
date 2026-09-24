// skyjs crypt core (Task 4 — crypto wrapper layer).
// Shared by the legacy lazy global and require('skyjs/crypt'); wraps
// skynetcore.crypt (pure-C hash/DES/DH/base64/hex, see js-crypto.c) with
// String→ArrayBuffer coercion and graceful OpenSSL detection.
(function () {
    "use strict";

    const cc = skynetcore.crypt;
    const encoder = new TextEncoder();

    // --------------------------------------------------------- helpers

    /**
     * Coerce input to ArrayBuffer.
     *   string      → UTF-8 encode to ArrayBuffer
     *   ArrayBuffer  → passthrough
     *   TypedArray   → slice underlying buffer to the view's range
     */
    function toAb(data) {
        if (data instanceof ArrayBuffer) return data;
        if (typeof data === "string") return encoder.encode(data).buffer;
        if (ArrayBuffer.isView(data)) {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        }
        throw new TypeError("crypt: expected string, ArrayBuffer, or TypedArray");
    }

    /**
     * Guard for OpenSSL-only functions that may not exist on skynetcore.crypt.
     */
    function requireOpenssl(name) {
        if (typeof cc[name] !== "function") {
            throw new Error("crypt." + name + " requires OpenSSL build (make TLS=openssl)");
        }
    }

    // ----------------------------------------------- padding constants

    const padding = Object.freeze({ iso7816_4: 0, pkcs7: 1 });

    // -------------------------------------------- public crypt object

    const crypt = {
        padding,

        // ---- Hash --------------------------------------------------

        sha1(data) {
            return cc.sha1(toAb(data));
        },
        sha256(data) {
            return cc.sha256(toAb(data));
        },
        sha512(data) {
            return cc.sha512(toAb(data));
        },

        // ---- HMAC (standard) ---------------------------------------

        hmacSha1(key, data) {
            return cc.hmacSha1(toAb(key), toAb(data));
        },
        hmacSha256(key, data) {
            return cc.hmacSha256(toAb(key), toAb(data));
        },
        hmacSha512(key, data) {
            return cc.hmacSha512(toAb(key), toAb(data));
        },

        // ---- Encoding ----------------------------------------------

        base64Encode(data) {
            return cc.base64Encode(toAb(data));
        },
        base64Decode(str) {
            // C side expects a JS string, not ArrayBuffer
            return cc.base64Decode(String(str));
        },
        hexEncode(data) {
            return cc.hexEncode(toAb(data));
        },
        hexDecode(str) {
            return cc.hexDecode(String(str));
        },

        // ---- AEAD (OpenSSL) ----------------------------------------

        aesGcmEncrypt(key, plaintext, iv, aad) {
            requireOpenssl("aesGcmEncrypt");
            return cc.aesGcmEncrypt(toAb(key), toAb(plaintext), toAb(iv),
                aad !== undefined ? toAb(aad) : undefined);
        },
        aesGcmDecrypt(key, ciphertext, iv, tag, aad) {
            requireOpenssl("aesGcmDecrypt");
            return cc.aesGcmDecrypt(toAb(key), toAb(ciphertext), toAb(iv),
                toAb(tag), aad !== undefined ? toAb(aad) : undefined);
        },

        // ---- Ed25519 (OpenSSL) -------------------------------------

        ed25519Keypair() {
            requireOpenssl("ed25519Keypair");
            return cc.ed25519Keypair();
        },
        ed25519Sign(secretKey, message) {
            requireOpenssl("ed25519Sign");
            return cc.ed25519Sign(toAb(secretKey), toAb(message));
        },
        ed25519Verify(publicKey, message, sig) {
            requireOpenssl("ed25519Verify");
            return cc.ed25519Verify(toAb(publicKey), toAb(message), toAb(sig));
        },

        // ---- X25519 (OpenSSL) --------------------------------------

        x25519Keypair() {
            requireOpenssl("x25519Keypair");
            return cc.x25519Keypair();
        },
        x25519Shared(secretKey, peerPublic) {
            requireOpenssl("x25519Shared");
            return cc.x25519Shared(toAb(secretKey), toAb(peerPublic));
        },

        // ---- Utility -----------------------------------------------

        randomBytes(n) {
            return cc.randomBytes(n | 0);
        },
        xorStr(data, key) {
            return cc.xorStr(toAb(data), toAb(key));
        },

        // ---- Skynet protocol compat --------------------------------

        randomkey() {
            return cc.randomkey();
        },
        hashkey(data) {
            return cc.hashkey(toAb(data));
        },
        desEncode(key, text, pad) {
            return cc.desEncode(toAb(key), toAb(text),
                pad !== undefined ? (pad | 0) : undefined);
        },
        desDecode(key, text, pad) {
            return cc.desDecode(toAb(key), toAb(text),
                pad !== undefined ? (pad | 0) : undefined);
        },
        hmac64(x, y) {
            return cc.hmac64(toAb(x), toAb(y));
        },
        hmac64Md5(x, y) {
            return cc.hmac64Md5(toAb(x), toAb(y));
        },
        hmacHash(key, text) {
            return cc.hmacHash(toAb(key), toAb(text));
        },
        dhExchange(key) {
            return cc.dhExchange(toAb(key));
        },
        dhSecret(x, y) {
            return cc.dhSecret(toAb(x), toAb(y));
        },
    };
    module.exports = crypt;
})();
