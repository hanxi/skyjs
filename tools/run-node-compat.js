#!/usr/bin/env node
"use strict";

// SkyJS / Node differential runner. Each case file exports a `run(impl)`
// function that receives the module under test and returns a comparable value;
// the same file is executed twice -- once under plain Node, once through the
// CJS loader inside skyjs -- and the JSON results are compared.
//
// Usage:
//   node tools/run-node-compat.js [--filter substr]
//   node tools/run-node-compat.js --skyjs-only        # debug the SkyJS side

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const CASES_DIR = path.join(ROOT, "test", "node-compat");
const BIN = path.join(ROOT, "skyjs");

function listCases(filter) {
    if (!fs.existsSync(CASES_DIR)) return [];
    return fs.readdirSync(CASES_DIR)
        .filter((name) => name.endsWith(".js"))
        .filter((name) => !filter || name.includes(filter))
        .sort();
}

/** Run a case in-process (Node side). */
function runInNode(file) {
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    return mod.run();
}

const SKYJS_CONFIG = path.join(ROOT, "build", "node-compat-config.json");

/** Run a case inside skyjs and read back the JSON result file. */
function runInSkyjs(file, outFile) {
    const driver = `
"use strict";
const caseModule = require(${JSON.stringify(file)});
const testing = require("skyjs/testing");
const result = caseModule.run();
testing.writeResult(${JSON.stringify(outFile)}, JSON.stringify(result));
`;
    const driverPath = path.join(ROOT, "build", "node-compat-driver.js");
    fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
    fs.writeFileSync(driverPath, driver);
    fs.writeFileSync(SKYJS_CONFIG, JSON.stringify({
        thread: 1,
        cpath: "./cservice/?.so;./test/cservice/?.so",
        bootstrap: "snjs " + driverPath,
        logservice: "logger",
    }, null, 2));

    const r = spawnSync(BIN, [SKYJS_CONFIG], {
        cwd: ROOT, encoding: "utf8", timeout: 15000,
    });
    if (!fs.existsSync(outFile)) {
        return { ok: false, error: "skyjs produced no result", stdout: r.stdout, stderr: r.stderr };
    }
    const raw = fs.readFileSync(outFile, "utf8");
    fs.unlinkSync(outFile);
    try {
        return { ok: true, value: JSON.parse(raw) };
    } catch (parseErr) {
        return { ok: false, error: "invalid result JSON: " + parseErr.message };
    }
}

function main() {
    const args = process.argv.slice(2);
    const filterIndex = args.indexOf("--filter");
    const filter = filterIndex >= 0 ? args[filterIndex + 1] : null;
    const cases = listCases(filter);
    if (cases.length === 0) {
        process.stdout.write("no node-compat cases found\n");
        process.exit(0);
    }

    let failures = 0;
    for (const name of cases) {
        const file = path.join(CASES_DIR, name);
        const outFile = path.join(ROOT, "build", "node-compat-" + name);
        let expected;
        try {
            expected = runInNode(file);
        } catch (nodeErr) {
            process.stdout.write("FAIL  " + name + "  (node threw: " +
                nodeErr.message + ")\n");
            failures++;
            continue;
        }
        const actual = runInSkyjs(file, outFile);
        if (!actual.ok) {
            process.stdout.write("FAIL  " + name + "  (" + actual.error + ")\n");
            if (actual.stderr) process.stdout.write("      " + String(actual.stderr).trim().split("\n").slice(-3).join("\n      ") + "\n");
            failures++;
            continue;
        }
        const a = JSON.stringify(actual.value);
        const b = JSON.stringify(expected);
        if (a === b) {
            process.stdout.write("PASS  " + name + "\n");
        } else {
            failures++;
            process.stdout.write("FAIL  " + name + "  mismatch\n");
            process.stdout.write("      node:  " + b + "\n");
            process.stdout.write("      skyjs: " + a + "\n");
        }
    }
    process.stdout.write("== " + (failures === 0 ? "ALL PASS" : failures + " FAILURE(S)") +
        " (" + cases.length + " cases) ==\n");
    process.exit(failures === 0 ? 0 : 1);
}

main();
