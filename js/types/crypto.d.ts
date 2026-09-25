// `require('crypto')` / `require('zlib')` over internal/crypt-core.

export interface Hash {
    update(data: string | ArrayBuffer | ArrayBufferView, encoding?: string): Hash;
    digest(encoding?: string): Uint8Array | string;
}

export interface Hmac {
    update(data: string | ArrayBuffer | ArrayBufferView, encoding?: string): Hmac;
    digest(encoding?: string): Uint8Array | string;
}

export function createHash(algorithm: string): Hash;
export function createHmac(algorithm: string, key: string | ArrayBuffer | ArrayBufferView): Hmac;
export function randomBytes(size: number): Uint8Array;
export function randomUUID(): string;
export function timingSafeEqual(a: ArrayBuffer | ArrayBufferView,
    b: ArrayBuffer | ArrayBufferView): boolean;
export function getHashes(): string[];
export function getCiphers(): string[];
export const constants: { defaultCoreCipherList: string };
