// Global fetch surface (NC4.3), installed by js/builtins/fetch.js.

export class Headers {
    constructor(init?: Record<string, string> | Array<[string, string]> | Headers);
    set(name: string, value: string): void;
    get(name: string): string | null;
    has(name: string): boolean;
    delete(name: string): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    forEach(cb: (value: string, key: string, headers: Headers) => void): void;
    [Symbol.iterator](): IterableIterator<[string, string]>;
}

export class Response {
    status: number;
    statusText: string;
    ok: boolean;
    headers: Headers;
    url: string;
    bodyUsed: boolean;
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    blob(): Promise<Blob>;
    clone(): Response;
}

export class Request {
    constructor(input: string, init?: object);
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

export function fetch(input: string | URL, init?: object): Promise<Response>;
