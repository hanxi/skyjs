// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

export interface FsxStat {
    size: number; mtime: number; isDir: boolean; isFile: boolean; mode: number;
}

export interface FsxFile {
    read(n: number): ArrayBuffer;
    write(data: string | ArrayBuffer | ArrayBufferView): void;
    seek(offset: number, whence?: number): void;
    tell(): number;
    close(): void;
}

export interface Fsx {
    readFile(path: string): ArrayBuffer;
    readTextFile(path: string): string;
    writeFile(path: string, data: string | ArrayBuffer | ArrayBufferView): void;
    appendFile(path: string, data: string | ArrayBuffer | ArrayBufferView): void;
    exists(path: string): boolean;
    stat(path: string): FsxStat;
    readdir(path: string): string[];
    mkdir(path: string, recursive?: boolean): void;
    remove(path: string): void;
    rename(oldPath: string, newPath: string): void;
    open(path: string, mode?: string): FsxFile;
    File: new (handle: number) => FsxFile;
    readFileAsync(path: string): Promise<ArrayBuffer>;
    readTextFileAsync(path: string): Promise<string>;
    writeFileAsync(path: string, data: string | ArrayBuffer | ArrayBufferView): Promise<void>;
    appendFileAsync(path: string, data: string | ArrayBuffer | ArrayBufferView): Promise<void>;
    statAsync(path: string): Promise<FsxStat>;
    readdirAsync(path: string): Promise<string[]>;
    mkdirAsync(path: string, recursive?: boolean): Promise<void>;
    removeAsync(path: string): Promise<void>;
    renameAsync(oldPath: string, newPath: string): Promise<void>;
}
