// `require('tls')` — common subset over skynetcore.tls (TLS=openssl builds).

import { Socket, Server } from "./net";

export class TLSSocket extends Socket {
    authorized: boolean;
    authorizationError: Error | null;
    servername: string;
}

export function connect(port: number | object, host?: string,
    options?: object, listener?: () => void): TLSSocket;
export function createServer(options?: object,
    connectionListener?: (socket: TLSSocket) => void): Server;
export function createSecureContext(options?: object): { context: object };
export const rootCertificates: string[];
export const DEFAULT_MIN_VERSION: string;
export const DEFAULT_MAX_VERSION: string;
