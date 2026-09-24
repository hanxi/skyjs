// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

export interface Socket {
    listen(host: string, port: number,
        onAccept: (id: number, address: string) => void, backlog?: number): number;
    connect(host: string, port: number, onConnect: (id: number) => void): number;
    start(id: number, onData?: (data: string | ArrayBuffer, ud?: number) => void,
        onClose?: (id: number) => void, onError?: (id: number, data: string) => void,
        opts?: { binary?: boolean }): void;
    resume(id: number): void;
    write(id: number, data: string | ArrayBuffer | ArrayBufferView): number;
    close(id: number): void;
    shutdown(id: number): void;
}

export class BufferedReader {
    readonly fd: number;
    closed: boolean;
    errorMsg: string | null;
    constructor(fd: number);
    read(n: number): Promise<ArrayBuffer>;
    readline(): Promise<string>;
    write(data: string | ArrayBuffer | ArrayBufferView): void;
}

export interface SocketHelper {
    readonly socketError: object;
    BufferedReader: typeof BufferedReader;
    connect(host: string, port: number, timeout?: number): Promise<number>;
    writefunc(fd: number): (data: string | ArrayBuffer | ArrayBufferView) => void;
    reader(fd: number): BufferedReader;
    tlsUpgrade(...args: unknown[]): Promise<void>;
}
