// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

interface RuntimeInfoResult {
    version: string; platform: string; arch: string;
    pid: number; ppid: number; execPath: string; uptime: number;
}

interface SkynetFeature {
    available: boolean;
    reason?: string;
    version?: string;
}

interface SkynetFeatureTable {
    version: string;
    sqlite: SkynetFeature;
    httpStream: SkynetFeature;
    fsAsync: SkynetFeature;
    archive: SkynetFeature;
    subprocess: SkynetFeature;
    media: SkynetFeature;
    tag: SkynetFeature;
    cryptExt: SkynetFeature;
    nativeExt: SkynetFeature & { dynamic: boolean; static: boolean };
    pluginSandbox: SkynetFeature;
}

interface IoStatResult {
    size: number; mtime: number; isDir: boolean; isFile: boolean; mode: number;
}

/** Lua table 的无损映射：0-based 数组段 + Map 哈希段。 */
declare class LuaTable<V = unknown> {
    constructor(array?: V[], hash?: Map<unknown, V>);
    array: V[];
    hash: Map<unknown, V>;
    readonly len: number;
    get(k: unknown): V | undefined;
    set(k: unknown, v: V): this;
    entries(): Array<[unknown, V]>;
    [Symbol.iterator](): IterableIterator<[unknown, V]>;
    toJSON(): Record<string, V>;
}

interface SkyjsBuffer extends Uint8Array {
    toString(encoding?: string, start?: number, end?: number): string;
    write(string: string, offset?: number, length?: number, encoding?: string): number;
    equals(other: Uint8Array): boolean;
    compare(other: Uint8Array): number;
    copy(target: Uint8Array, targetStart?: number, sourceStart?: number,
        sourceEnd?: number): number;
}

interface SkyjsBufferConstructor {
    new(value: number | string | ArrayBuffer | ArrayBufferView | number[],
        encodingOrOffset?: string | number, length?: number): SkyjsBuffer;
    from(value: number | string | ArrayBuffer | ArrayBufferView | number[],
        encodingOrOffset?: string | number, length?: number): SkyjsBuffer;
    alloc(size: number, fill?: unknown, encoding?: string): SkyjsBuffer;
    allocUnsafe(size: number): SkyjsBuffer;
    allocUnsafeSlow(size: number): SkyjsBuffer;
    byteLength(value: string | ArrayBuffer | ArrayBufferView, encoding?: string): number;
    isBuffer(value: unknown): value is SkyjsBuffer;
    isEncoding(encoding: string): boolean;
    compare(a: Uint8Array, b: Uint8Array): number;
    concat(list: Uint8Array[], totalLength?: number): SkyjsBuffer;
    readonly kMaxLength: number;
    poolSize: number;
}

declare const Buffer: SkyjsBufferConstructor;

declare class TextEncoder {
    readonly encoding: string;
    encode(input?: string): Uint8Array;
    encodeInto(input: string, destination: Uint8Array): { read: number; written: number };
}

declare class TextDecoder {
    readonly encoding: string;
    constructor(label?: string);
    decode(input?: ArrayBuffer | ArrayBufferView): string;
}

interface AbortSignalLike {
    readonly aborted: boolean;
    readonly reason: unknown;
    onabort: ((event: unknown) => void) | null;
    throwIfAborted(): void;
    addEventListener(type: string, listener: unknown): void;
    removeEventListener(type: string, listener: unknown): void;
    dispatchEvent(event: unknown): boolean;
}

declare const AbortSignal: {
    new(): AbortSignalLike;
    abort(reason?: unknown): AbortSignalLike;
    timeout(ms: number): AbortSignalLike;
};

declare const AbortController: {
    new(): { readonly signal: AbortSignalLike; abort(reason?: unknown): void };
};

interface TimerHandle {
    ref(): TimerHandle;
    unref(): TimerHandle;
    hasRef(): boolean;
    refresh(): TimerHandle;
}

interface ImmediateHandle {
    ref(): ImmediateHandle;
    unref(): ImmediateHandle;
    hasRef(): boolean;
}

declare function setTimeout(callback: (...args: unknown[]) => void, delay?: number,
    ...args: unknown[]): TimerHandle;
declare function clearTimeout(handle: TimerHandle): void;
declare function setInterval(callback: (...args: unknown[]) => void, delay?: number,
    ...args: unknown[]): TimerHandle;
declare function clearInterval(handle: TimerHandle): void;
declare function setImmediate(callback: (...args: unknown[]) => void,
    ...args: unknown[]): ImmediateHandle;
declare function clearImmediate(handle: ImmediateHandle): void;
declare function queueMicrotask(callback: () => void): void;

interface ProcessWriteStream {
    isTTY: false;
    write(chunk: string | Uint8Array, encoding?: string | (() => void),
        callback?: () => void): boolean;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    off(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    emit(event: string, ...args: unknown[]): boolean;
}

interface ProcessShim {
    version: string;
    versions: { node: string; skyjs: string; quickjs: string };
    platform: string;
    arch: string;
    pid: number;
    ppid: number;
    argv: string[];
    argv0: string;
    execPath: string;
    env: Record<string, string>;
    cwd(): string;
    chdir(path: string): void;
    exit(code?: number): never;
    exitCode: number;
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
    hrtime(previous?: [number, number]): [number, number];
    memoryUsage(): { rss: number; heapTotal: number; heapUsed: number; external: number };
    uptime(): number;
    stdout: ProcessWriteStream;
    stderr: ProcessWriteStream;
    stdin: null;
}

declare const process: ProcessShim;

/** 启动参数；用户脚本 eval 完成后由 snjs 注入。 */
declare const snjsParam: string;

interface SkyjsFsPrimitives {
    readFile(path: string): ArrayBuffer;
    writeFile(path: string, data: ArrayBuffer): void;
    appendFile(path: string, data: ArrayBuffer): void;
    exists(path: string): boolean;
    stat(path: string): IoStatResult;
    readdir(path: string): string[];
    mkdir(path: string): void;
    remove(path: string): void;
    rename(oldPath: string, newPath: string): void;
    open(path: string, mode: string): number;
    fread(handle: number, n: number): ArrayBuffer;
    fwrite(handle: number, data: ArrayBuffer): void;
    fseek(handle: number, offset: number, whence: number): void;
    ftell(handle: number): number;
    fclose(handle: number): void;
    str2ab(s: string): ArrayBuffer;
}

interface SkyjsNetPrimitives {
    listen(host: string, port: number, backlog?: number): number;
    connect(host: string, port: number): number;
    start(id: number): void;
    send(id: number, data: string | ArrayBuffer): number;
    close(id: number): void;
    shutdown(id: number): void;
    nodelay(id: number): void;
    netpackMode(): void;
}

interface SkyjsNetpackPrimitives {
    pop(): { fd: number; data: ArrayBuffer } | null;
    pack(data: string | ArrayBuffer): ArrayBuffer;
    clear(): void;
}

interface SkyjsSeriPrimitives {
    pack(...vals: unknown[]): ArrayBuffer;
    unpack(buf: ArrayBuffer | string): unknown[];
    str(buf: ArrayBuffer): string;
}

/**
 * Grouped C primitives (NC0.3+). Legacy flat names were removed in NC0.8:
 * use `skynetcore.runtime.*` / `.fs` / `.net` / `.seri`.
 */
declare const skynetcore: {
    features(): SkynetFeatureTable;
    runtime: {
        send(dest: number, type: number, msg: string | ArrayBuffer | null,
            session?: number): number;
        command(cmd: string, arg?: string): string | null;
        intCommand(cmd: string, arg?: string): number;
        genId(): number;
        now(): number;
        error(msg: string): void;
        mem(): number;
        response(session: number, source: number,
            msg: string | ArrayBuffer | null): void;
        errorResponse(session: number, source: number): void;
        redirect(dest: number, source: number, type: number, session: number,
            msg: string | ArrayBuffer | null): number;
        exit(code?: number): void;
        exitCode(code: number): void;
        argv(): string[];
        info(): RuntimeInfoResult;
        hrtime(): [number, number];
        environ(): Record<string, string>;
        readModuleSource(id: string): string | null;
    };
    fs: SkyjsFsPrimitives;
    net: SkyjsNetPrimitives;
    netpack: SkyjsNetpackPrimitives;
    seri: SkyjsSeriPrimitives;
    crypt: Record<string, (...args: unknown[]) => unknown>;
    tls?: Record<string, (...args: unknown[]) => unknown>;
};

declare const skynet: {
    version: string;
    features(): SkynetFeatureTable;
    PTYPE_TEXT: number;
    PTYPE_RESPONSE: number;
    PTYPE_ERROR: number;
    PTYPE_LUA: number;
    PTYPE_CLIENT: number;
    start(startFunc: () => void): void;
    dispatch<T = unknown>(typename: string,
        fn: (msg: T, source?: number, session?: number) => unknown): void;
    registerProtocol(p: { name: string; id: number; dispatch?: unknown }): void;
    call<T = unknown>(dest: number, typename: string,
        msg?: string | ArrayBuffer | null): Promise<T>;
    send(addr: number, typename: string, ...args: unknown[]): number;
    redirect(dest: number, source: number, typename: string, session: number,
        msg?: string | ArrayBuffer | null): number;
    /** 定时器，单位厘秒（10ms），同原版 skynet.timeout */
    timeout(centiseconds: number, fn: () => void): number;
    sleep(ms: number): Promise<void>;
    fork<T>(fn: () => T | Promise<T>): Promise<T>;
    newservice(name: string, param?: string): number;
    self(): number;
    register(name: string): void;
    getenv(key: string): any;
    now(): number;
    memStat(): number;
    pack(...vals: unknown[]): ArrayBuffer;
    unpack(buf: ArrayBuffer | string): unknown[];
    exit(): void;
};
