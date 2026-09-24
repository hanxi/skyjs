// Split out of js/skyjs.d.ts in NC0.8; module-scoped types for the
// require()-based runtime surface.

export interface SkyjsCluster {
    init(): void;
    setNodes(nodes: Record<string, string>): void;
    open(port: number): void;
    register(name: string): void;
    call<T = unknown>(node: string, addr: string | number, ...args: unknown[]): Promise<T[]>;
    send(node: string, addr: string | number, ...args: unknown[]): void;
    query(node: string, name: string): Promise<unknown>;
}

export interface SkyjsGateserver {
    openclient(fd: number): void;
    closeclient(fd: number): void;
    open(host: string, port: number, backlog?: number,
        maxClient?: number, nodelay?: boolean): number;
    close(): void;
    start(handler: unknown): void;
}
