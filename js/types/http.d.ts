// `require('http')` / `require('https')` — common subset over internal/http-core.

import { Readable, Writable } from "./stream";

export class IncomingMessage extends Readable {
    method: string | null;
    url: string | null;
    statusCode: number | null;
    headers: Record<string, string | string[]>;
    rawHeaders: string[];
    httpVersion: string;
    socket: unknown;
}

export class ServerResponse extends Writable {
    statusCode: number;
    headersSent: boolean;
    setHeader(name: string, value: string | string[]): this;
    getHeader(name: string): string | string[] | undefined;
    removeHeader(name: string): void;
    writeHead(statusCode: number, statusMessage?: string,
        headers?: Record<string, string | string[]>): this;
}

export class Server {
    listening: boolean;
    timeout: number;
    listen(port: number, host?: string, callback?: () => void): this;
    address(): { address: string; family: string; port: number };
    close(callback?: () => void): this;
    setTimeout(ms: number, callback?: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
}

export interface ClientRequestOptions {
    hostname?: string;
    host?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | ArrayBufferView;
}

export interface ClientResponse {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string | string[]>;
    body: Uint8Array;
}

export function createServer(options?: object,
    requestListener?: (req: IncomingMessage, res: ServerResponse) => void): Server;
export function request(options: ClientRequestOptions | string,
    callback?: () => void): Promise<ClientResponse>;
export function get(options: ClientRequestOptions | string,
    callback?: () => void): Promise<ClientResponse>;
export const STATUS_CODES: Record<number, string>;
