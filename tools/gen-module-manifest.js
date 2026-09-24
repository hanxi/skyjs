"use strict";

// Generate the deterministic SkyJS module manifest.
//
// Scope (docs/node-compatibility.md §16.9): js/bootstrap.js, js/loader.js,
// js/internal/**, and js/builtins/**. Existing legacy top-level libraries are
// intentionally outside the manifest until they are migrated in NC0.7.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const JS_ROOT = path.join(ROOT, "js");
const MANIFEST_FORMAT = 1;
const FIXED_FILES = ["bootstrap.js", "loader.js"];
const TREES = ["internal", "builtins"];

function toPosix(p) {
    return p.split(path.sep).join("/");
}

function walkTree(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
            out.push(...walkTree(full));
        } else if (/\.(?:js|json)$/.test(name)) {
            out.push(full);
        }
    }
    return out;
}

function collectFiles() {
    const files = [];
    for (const rel of FIXED_FILES) {
        const full = path.join(JS_ROOT, rel);
        if (fs.existsSync(full)) files.push(full);
    }
    for (const tree of TREES) {
        files.push(...walkTree(path.join(JS_ROOT, tree)));
    }
    return [...new Set(files)].sort();
}

function sha256(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function buildManifest() {
    const files = collectFiles();
    return {
        format: MANIFEST_FORMAT,
        source: "disk",
        files: files.map((file) => ({
            id: toPosix(path.relative(JS_ROOT, file)),
            path: toPosix(path.relative(ROOT, file)),
            sha256: sha256(file),
        })),
    };
}

function serializeManifest(manifest) {
    return JSON.stringify(manifest, null, 2) + "\n";
}

function listFiles() {
    process.stdout.write(collectFiles().map((file) =>
        toPosix(path.relative(ROOT, file))).join("\n") + "\n");
}

function check(output) {
    if (!fs.existsSync(output)) {
        process.stderr.write("module manifest not found: " + output + "\n");
        process.exit(1);
    }
    const current = fs.readFileSync(output, "utf8");
    const expected = serializeManifest(buildManifest());
    if (current !== expected) {
        process.stderr.write("module manifest mismatch: " + output + "\n");
        process.exit(1);
    }
}

function write(output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serializeManifest(buildManifest()));
}

function parseArgs(argv) {
    const opts = { check: false, output: path.join(ROOT, "build", "module-manifest.json") };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--check") opts.check = true;
        else if (argv[i] === "--output") opts.output = path.resolve(argv[++i]);
        else if (argv[i] === "--list-files") opts.listFiles = true;
        else {
            process.stderr.write("unknown option: " + argv[i] + "\n");
            process.exit(2);
        }
    }
    return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.listFiles) {
    listFiles();
} else if (opts.check) {
    check(opts.output);
} else {
    write(opts.output);
}
