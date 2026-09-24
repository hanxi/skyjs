// eslint.config.js -- flat config for SkyJS JS sources.
//
// Two runtimes, two override sets:
//   - QuickJS side (js/, test/service/, examples/): globals injected by the
//     snjs loader (skynetcore, skynet, socket, ...). Since NC0.2, service and
//     runtime modules also receive the module-local CJS five-tuple.
//   - Node side (tools/): real CommonJS scripts (require/process, and the
//     retired-name list is exempted here because the ESLint config itself
//     and the harness scripts mention those names in their rules/comments).
//
// Naming: lowerCamelCase identifiers, UpperCamelCase classes,
// UPPER_SNAKE_CASE constants, `__`-prefixed C↔JS contract globals allowed
// (e.g. __snjs_wrap), domain whitelist iso7816_4. Frozen-domain strings
// (io RPC op strings "read_file"..., env keys, markers) live in string
// literals, which AST rules do not touch.
const js = require("@eslint/js");
const tseslint = require("@typescript-eslint/eslint-plugin");
const tsparser = require("@typescript-eslint/parser");

// globals injected by the snjs QuickJS loader (js/skynet.js et al.)
const quickjsGlobals = {
    skynetcore: "readonly", skynet: "readonly", socket: "readonly",
    crypt: "readonly", sockethelper: "readonly", cluster: "readonly",
    gateserver: "readonly", httpd: "readonly", httpc: "readonly",
    httpInternal: "readonly", websocket: "readonly", io: "readonly",
    console: "readonly", LuaTable: "readonly", snjsParam: "readonly",
    TextEncoder: "readonly", TextDecoder: "readonly",
    dispatch: "writable", // user services define globalThis.dispatch
};

// retired API names: pre-2026-09 snake_case and the older concatenated
// spellings; must not sneak back into QuickJS-side code. id-match REQUIRES a
// match, so the pattern below is a negative lookahead: any valid identifier
// passes, the retired names alone fail. id-match only checks identifiers —
// string literals (frozen io RPC op strings) are unaffected.
const retiredNames = [
    "intcommand", "genid", "readfile", "writefile",
    "int_command", "gen_id", "error_response", "netpack_mode",
    "snjs_param", "mem_stat", "register_protocol", "set_nodes",
].join("|");

const naming = [
    // variables / functions: lowerCamelCase, optional single leading `_`,
    // double `__` allowed for C contract globals, UPPER_SNAKE constants ok
    { selector: "variableLike", format: ["camelCase", "UPPER_CASE"],
      leadingUnderscore: "allowSingleOrDouble",
      filter: { regex: "iso7816_4", match: false } },
    // class / type names: PascalCase (UPPER_CASE tolerated for consistency)
    { selector: "typeLike", format: ["PascalCase", "UPPER_CASE"],
      filter: { regex: "iso7816_4", match: false } },
];

module.exports = [
    {
        ignores: ["node_modules/**", "build/**", "cservice/**",
            "3rd/**", "platform/**", "service-src/**", "test/cservice/**",
            "test/cluster-lua/**", "test/bench-lua/**",
            "examples/ts-echo/ts-echo.js", "js/skyjs.d.ts"],
    },
    // ---- default: QuickJS-side sources -------------------------------
    {
        files: ["js/**/*.js", "test/service/**/*.js",
            "examples/**/*.js", "examples/**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: { ecmaVersion: "latest", sourceType: "script" },
            globals: quickjsGlobals,
        },
        plugins: { "@typescript-eslint": tseslint },
        rules: {
            ...js.configs.recommended.rules,
            ...tseslint.configs.recommended.rules,
            "no-var": "error",
            "no-tabs": "error",
            "@typescript-eslint/naming-convention": ["error", ...naming],
            "id-match": ["error",
                "^(?!(?:" + retiredNames + ")$)[A-Za-z_$][\\w$]*$",
                { properties: false, classFields: false }],
            "no-undef": "off", // globals are injected at runtime by the C loader
            // CJS require/module.exports are provided as wrapper parameters,
            // not Node imports; the runtime owns the compatibility loader.
            "@typescript-eslint/no-require-imports": "off",
            "@typescript-eslint/no-unused-vars": "off", // handled by review; QuickJS has no tree-shaking semantics to protect
            // ts-echo references the ambient declaration file by path (esbuild
            // bundle with --platform=neutral has no module resolution for it)
            "@typescript-eslint/triple-slash-reference": "off",
        },
    },
    // ---- tools/: real Node scripts ----------------------------------
    {
        files: ["tools/**/*.js", "eslint.config.js"],
        languageOptions: {
            ecmaVersion: "latest", sourceType: "commonjs",
            globals: {
                require: "readonly", module: "readonly", exports: "writable",
                process: "readonly", console: "readonly", Buffer: "readonly",
                __dirname: "readonly", __filename: "readonly",
                setTimeout: "readonly", clearTimeout: "readonly",
                setInterval: "readonly", clearInterval: "readonly",
                setImmediate: "readonly", clearImmediate: "readonly",
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            "no-var": "error",
            "no-tabs": "error",
        },
    },
];
