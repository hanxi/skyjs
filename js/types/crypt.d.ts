// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

export interface Crypt {
    readonly padding: { readonly iso7816_4: 0; readonly pkcs7: 1 };
    sha1(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    sha256(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    sha512(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmacSha1(key: string | ArrayBuffer | ArrayBufferView,
        data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmacSha256(key: string | ArrayBuffer | ArrayBufferView,
        data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmacSha512(key: string | ArrayBuffer | ArrayBufferView,
        data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    base64Encode(data: string | ArrayBuffer | ArrayBufferView): string;
    base64Decode(str: string): ArrayBuffer;
    hexEncode(data: string | ArrayBuffer | ArrayBufferView): string;
    hexDecode(str: string): ArrayBuffer;
    xorStr(data: string | ArrayBuffer | ArrayBufferView,
        key: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    randomBytes(n: number): ArrayBuffer;
    randomkey(): ArrayBuffer;
    hashkey(data: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    desEncode(key: string | ArrayBuffer | ArrayBufferView,
        text: string | ArrayBuffer | ArrayBufferView, padding?: number): ArrayBuffer;
    desDecode(key: string | ArrayBuffer | ArrayBufferView,
        text: string | ArrayBuffer | ArrayBufferView, padding?: number): ArrayBuffer;
    hmac64(x: string | ArrayBuffer | ArrayBufferView,
        y: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmac64Md5(x: string | ArrayBuffer | ArrayBufferView,
        y: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    hmacHash(key: string | ArrayBuffer | ArrayBufferView,
        text: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    dhExchange(key: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
    dhSecret(x: string | ArrayBuffer | ArrayBufferView,
        y: string | ArrayBuffer | ArrayBufferView): ArrayBuffer;
}
