#!/usr/bin/env node
"use strict";

// packages/ boundary gate (docs/node-compatibility.md §16.4.1, §10 收口标准).
//
// Verifies the "delete packages/ and the engine still builds, boots, and passes
// its self-verification" contract:
//
//   A. layout: every packages/<name> has package.json with a name, and no
//      packages/ entry shadows an engine-internal skyjs/* builtin;
//   B. purity: no file under packages/ requires js/internal/* or reaches for
//      skynetcore.* directly (rule 1 of §16.4.1);
//   C. engine independence: no file under js/ requires a package-only
//      @skyjs/<name> or a packages/ path (rule 2);
//   D. boot: with packages/ temporarily hidden, the engine-only scenario must
//      reach its OK marker (layer-1 modules + all 8 engine entries).
//
// Usage: node tools/check-packages-boundary.js [--keep]   (--keep skips D)

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const JS_ROOT = path.join(ROOT, "js");
const BIN = path.join(ROOT, "skyjs");
const ENGINE_ONLY_CONFIG = path.join(ROOT, "test", "config-engine-only.json");
const HIDDEN = path.join(ROOT, ".packages-hidden");

// Engine-internal skyjs/* entries (§16.4.1: exactly 8, pluginHost not yet built).
const ENGINE_ENTRIES = [
    "fsx", "subprocess", "crypt", "cluster", "gateserver", "log", "testing",
];

// Matches a quoted module specifier (single, double, or backtick).
const QUOTE_RE_SRC = "[\"'`]";

const failures = [];
function fail(msg) { failures.push(msg); }

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) walk(full, out);
        else if (/\.(?:js|json)$/.test(name)) out.push(full);
    }
    return out;
}

// ---------------------------------------------------------------- A. layout

function checkLayout() {
    if (!fs.existsSync(PACKAGES)) {
        process.stdout.write("  packages/ absent; nothing to check\n");
        return [];
    }
    const names = fs.readdirSync(PACKAGES)
        .filter((n) => fs.statSync(path.join(PACKAGES, n)).isDirectory());
    for (const name of names) {
        const manifestPath = path.join(PACKAGES, name, "package.json");
        if (!fs.existsSync(manifestPath)) {
            fail("packages/" + name + ": missing package.json");
            continue;
        }
        let manifest;
        try {
            manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (parseErr) {
            fail("packages/" + name + ": package.json is not valid JSON (" +
                parseErr.message + ")");
            continue;
        }
        const expected = "@skyjs/" + name;
        if (manifest.name !== expected) {
            fail("packages/" + name + ": package.json name is " +
                JSON.stringify(manifest.name) + ", expected " + JSON.stringify(expected));
        }
        if (ENGINE_ENTRIES.includes(name)) {
            fail("packages/" + name +
                ": shadows an engine-internal skyjs/* entry (§16.4.1)");
        }
    }
    return names;
}

// ---------------------------------------------------------------- B. purity

function checkPackagePurity(names) {
    let checked = 0;
    for (const name of names) {
        for (const file of walk(path.join(PACKAGES, name))) {
            const rel = path.relative(ROOT, file);
            const text = fs.readFileSync(file, "utf8");
            checked++;
            // Rule 1: packages must not reach into engine-private internals.
            if (/require\(\s*["'`][^"'`]*js\/internal\//.test(text) ||
                /require\(\s*["'`]internal\//.test(text)) {
                fail(rel + ": package requires an engine-private internal module");
            }
            // Rule 1: packages must not call skynetcore.* directly.
            const stripped = text
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
            if (/\bskynetcore\s*\./.test(stripped)) {
                fail(rel + ": package references skynetcore.* directly");
            }
        }
    }
    return checked;
}

// ------------------------------------------------- C. engine independence

function checkEngineIndependence(names) {
    // Package-only @skyjs names = declared packages minus engine entries.
    const packageOnly = names.filter((n) => !ENGINE_ENTRIES.includes(n));
    let checked = 0;
    for (const file of walk(JS_ROOT)) {
        const rel = path.relative(ROOT, file);
        const text = fs.readFileSync(file, "utf8");
        checked++;
        for (const name of packageOnly) {
            const re = new RegExp(QUOTE_RE_SRC + "(@skyjs/" + name +
                "|skyjs/" + name + ")" + QUOTE_RE_SRC);
            if (re.test(text)) {
                fail(rel + ": engine requires package-only entry skyjs/" + name);
            }
        }
        if (/require\(\s*["'`][^"'`]*\.\.\/(?:\.\.\/)*packages\//.test(text) ||
            /require\(\s*["'`]packages\//.test(text)) {
            fail(rel + ": engine requires a path under packages/");
        }
    }
    return checked;
}

// ---------------------------------------------------------------- D. boot

function runEngineOnly() {
    return new Promise((resolve) => {
        const child = spawn(BIN, [ENGINE_ONLY_CONFIG], { cwd: ROOT });
        let out = "";
        let ok = false;
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 30000);
        for (const st of [child.stdout, child.stderr]) {
            st.on("data", (buf) => {
                const text = buf.toString();
                out += text;
                if (text.includes("ENGINE_ONLY_OK")) {
                    ok = true;
                    clearTimeout(timer);
                    child.kill("SIGTERM");
                }
            });
        }
        child.on("close", () => {
            clearTimeout(timer);
            if (!ok) resolve({ ok: false, out });
            else resolve({ ok: true, out });
        });
    });
}

function hidePackages() {
    if (!fs.existsSync(PACKAGES)) return false;
    fs.renameSync(PACKAGES, HIDDEN);
    return true;
}

function restorePackages(hidden) {
    if (hidden && fs.existsSync(HIDDEN)) fs.renameSync(HIDDEN, PACKAGES);
}

// ------------------------------------------------------------------- main

async function main() {
    const keep = process.argv.includes("--keep");
    process.stdout.write("packages/ boundary gate\n");

    process.stdout.write("[A] layout\n");
    const names = checkLayout();

    process.stdout.write("[B] package purity\n");
    const b = checkPackagePurity(names);
    process.stdout.write("    checked " + b + " package file(s)\n");

    process.stdout.write("[C] engine independence\n");
    const c = checkEngineIndependence(names);
    process.stdout.write("    checked " + c + " engine file(s)\n");

    if (!keep) {
        process.stdout.write("[D] boot without packages/ (self-verification)\n");
        let hidden = false;
        try {
            hidden = hidePackages();
            process.stdout.write("    packages/ " +
                (hidden ? "hidden" : "already absent") + "\n");
            const result = await runEngineOnly();
            if (!result.ok) {
                fail("engine-only scenario did not reach ENGINE_ONLY_OK");
                for (const line of result.out.trim().split("\n").slice(-12)) {
                    process.stdout.write("      | " + line + "\n");
                }
            }
        } finally {
            restorePackages(hidden);
        }
    } else {
        process.stdout.write("[D] skipped (--keep)\n");
    }

    if (failures.length === 0) {
        process.stdout.write("== PACKAGES_BOUNDARY_OK ==\n");
        process.exit(0);
    }
    for (const f of failures) process.stdout.write("FAIL  " + f + "\n");
    process.stdout.write("== PACKAGES_BOUNDARY_FAILED (" + failures.length + ") ==\n");
    process.exit(1);
}

main();
