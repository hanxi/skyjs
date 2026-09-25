// `require('zlib')` — deflate/inflate + gzip.

declare function sync(data: string | ArrayBuffer | ArrayBufferView): Uint8Array;
declare function async(data: string | ArrayBuffer | ArrayBufferView): Promise<Uint8Array>;

export const deflateSync: typeof sync;
export const inflateSync: typeof sync;
export const gzipSync: typeof sync;
export const gunzipSync: typeof sync;
export const deflate: typeof async;
export const inflate: typeof async;
export const gzip: typeof async;
export const gunzip: typeof async;
export const constants: Record<string, number | string>;
