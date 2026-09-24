let ok = false;

try {
    sloppyProbe = 42;
    ok = sloppyProbe === 42;
    delete globalThis.sloppyProbe;
} catch {
    // Strict mode would reject the implicit global assignment above.
}

module.exports = { ok };
