// `require('skyjs/testing')`: engine self-verification contract.

export interface TestingSummary {
    checks: number;
    failures: number;
}

declare const testing: {
    ok(value: unknown, message?: string): unknown;
    equal(actual: unknown, expected: unknown, message?: string): unknown;
    deepEqual(actual: unknown, expected: unknown, message?: string): unknown;
    fail(message?: string): never;
    writeResult(file: string, text?: string): void;
    summary(): TestingSummary;
};
export = testing;
