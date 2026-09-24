// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

export interface WebSocketHandler {
    message(id: number, data: string | ArrayBuffer, opcode?: string): void;
    connect?(id: number, addr: string): void;
    disconnect?(id: number): void;
}

export interface WebSocketDataMessage {
    data: string | ArrayBuffer;
    type: string;
    close: false;
}

export interface WebSocketCloseMessage {
    data: null;
    close: true;
    code: number;
    reason: string;
}

export interface WebSocketApi {
    accept(fd: number, handler: WebSocketHandler, protocol?: string,
        addr?: string, options?: unknown): Promise<void>;
    connect(url: string, header?: Record<string, string>,
        timeout?: number): Promise<number>;
    read(id: number): Promise<WebSocketDataMessage | WebSocketCloseMessage>;
    write(id: number, data: string | ArrayBuffer, fmt?: string): void;
    ping(id: number): void;
    close(id: number, code?: number, reason?: string): void;
    addrinfo(id: number): string;
    realIp(id: number): string;
    isClose(id: number): boolean;
}
