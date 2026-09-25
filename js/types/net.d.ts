// Split out of js/skyjs.d.ts in NC0.8; require()-only surface since then.

export interface SocketOptions {
    host?: string;
    port?: number;
    timeout?: number;
}

export class Socket {
    connecting: boolean;
    destroyed: boolean;
    remoteAddress: string;
    remotePort: number;
    connect(port: number | SocketOptions, host?: string | (() => void),
        listener?: () => void): this;
    write(data: string | ArrayBuffer | ArrayBufferView, encoding?: string,
        callback?: () => void): boolean;
    end(data?: string | ArrayBuffer | ArrayBufferView, encoding?: string,
        callback?: () => void): this;
    setTimeout(ms: number, listener?: () => void): this;
    setNoDelay(on?: boolean): this;
    setKeepAlive(enable?: boolean): this;
    address(): { address: string; family: string; port: number };
    destroy(err?: Error): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    static connect(port: number | SocketOptions, host?: string,
        listener?: () => void): Socket;
}

export class Server {
    listening: boolean;
    maxConnections?: number;
    listen(port: number | object, host?: string, callback?: () => void): this;
    address(): { address: string; family: string; port: number };
    close(callback?: () => void): this;
    getConnections(callback: (err: Error | null, count: number) => void): number;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
}

export function createServer(options?: object,
    connectionListener?: (socket: Socket) => void): Server;
export function connect(port: number | SocketOptions, host?: string,
    listener?: () => void): Socket;
export function createConnection(...args: unknown[]): Socket;
export function isIP(value: string): number;
export function isIPv4(value: string): boolean;
export function isIPv6(value: string): boolean;
