// `require('skyjs/log')` structured logging helper (skynet log channel).

export type LogFields = Record<string, unknown>;

export interface Logger {
    trace(fields: LogFields | string, ...rest: unknown[]): void;
    debug(fields: LogFields | string, ...rest: unknown[]): void;
    info(fields: LogFields | string, ...rest: unknown[]): void;
    warn(fields: LogFields | string, ...rest: unknown[]): void;
    error(fields: LogFields | string, ...rest: unknown[]): void;
    fatal(fields: LogFields | string, ...rest: unknown[]): void;
    child(fields: LogFields): Logger;
}

declare const log: Logger;
export = log;
