// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

export interface HttpRequest {
    method: string;
    url: string;
    body: string;
    code: number;
    header: Record<string, string | string[]>;
}

export interface HttpResponse {
    status: number;
    body: string;
    header: Record<string, string | string[]>;
}

export interface Httpd {
    readRequest(reader: unknown, bodylimit?: number): Promise<HttpRequest>;
    writeResponse(write: (data: string | ArrayBuffer) => void, code: number,
        body: string | (() => string | null), header?: Record<string, string>): void;
}

export interface Httpc {
    request(method: string, hostname: string, url: string,
        recvHeader?: Record<string, string>, header?: Record<string, string>,
        body?: string, options?: unknown): Promise<HttpResponse>;
    get(hostname: string, url: string, recvHeader?: Record<string, string>,
        header?: Record<string, string>, options?: unknown): Promise<HttpResponse>;
    post(hostname: string, url: string, form: Record<string, unknown>,
        recvHeader?: Record<string, string>, options?: unknown): Promise<HttpResponse>;
    head(hostname: string, url: string, recvHeader?: Record<string, string>,
        header?: Record<string, string>, options?: unknown): Promise<number>;
    closeAllKeepalive(): void;
}

export interface HttpInternal {
    recvHeader(reader: unknown): Promise<{ lines: string[]; ok: boolean }>;
    parseHeader(lines: string[], from: number,
        header: Record<string, unknown>): Record<string, unknown> | null;
    recvChunkedBody(...args: unknown[]): Promise<string>;
    recvBody(...args: unknown[]): Promise<string>;
    httpStatusMsg(code: number): string;
}
