// `require('buffer')` entry, same implementation as the global Buffer.

export interface BufferConstants {
    MAX_LENGTH: number;
    MAX_STRING_LENGTH: number;
    MAX_SAFE_INTEGER: number;
}

export class Blob {
    constructor(parts?: Array<string | ArrayBuffer | ArrayBufferView | Blob>,
        options?: { type?: string });
    readonly size: number;
    readonly type: string;
    arrayBuffer(): Promise<ArrayBuffer>;
    bytes(): Promise<Uint8Array>;
    text(): Promise<string>;
    slice(start?: number, end?: number, type?: string): Blob;
}

export class File extends Blob {
    constructor(parts?: Array<string | ArrayBuffer | ArrayBufferView | Blob>,
        name?: string, options?: { type?: string; lastModified?: number });
    readonly name: string;
    readonly lastModified: number;
}
