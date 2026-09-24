// Gate acceptance: bootstraps the watchdog (which launches + opens the gate),
// then connects as a TCP client and exercises the full gate/redirect path with
// the C netpack frame buffer. Covers binary-safe payloads, coalesced frames
// (two packets in one write) and a split frame (partial reassembly). The agent
// echoes each packet's raw payload back; the client asserts the concatenated
// echo equals the concatenation of the sent payloads and prints GATE_OK.
"use strict";

const socket = require("../../js/internal/net-core.js");

const PORT = 18855;

function strBytes(s) {
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
    return a;
}

function concatBytes(list) {
    let total = 0;
    for (const u of list) total += u.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const u of list) { out.set(u, off); off += u.length; }
    return out;
}

function frame(u8) {
    // 2-byte big-endian length prefix via the C netpack packer
    return new Uint8Array(skynetcore.netpack.pack(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)));
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// payloads: plain text, embedded NUL/0xff/newline (binary-safe), a large one,
// and a trailing marker sent as a split frame
const pa = strBytes("ping");
const pb = new Uint8Array([0x00, 0x01, 0x02, 0x62, 0x69, 0x6e, 0xff, 0x0a, 0x00]);
const pc = (function () {
    const u = new Uint8Array(5000);
    for (let i = 0; i < u.length; i++) u[i] = i & 0xff;
    return u;
})();
const pd = strBytes("last");

async function runClient(tag) {
    const expected = concatBytes([pa, pb, pc, pd]);
    let recv = new Uint8Array(0);
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const id = socket.connect("127.0.0.1", PORT, () => {
        socket.start(id, (data) => {
            const chunk = new Uint8Array(data);
            recv = concatBytes([recv, chunk]);
            if (recv.length >= expected.length) resolveDone();
        }, () => {}, (fd, err) => {
            skynetcore.runtime.error("CLIENT socket error " + err);
        }, { binary: true });

        // frame 1: single packet
        socket.write(id, frame(pa));
        // frames 2+3: two packets coalesced into one write (exercises "more")
        socket.write(id, concatBytes([frame(pb), frame(pc)]));
        // frame 4: split across two writes with a gap (exercises reassembly)
        const f = frame(pd);
        const half = Math.floor(f.length / 2);
        socket.write(id, f.slice(0, half));
        skynet.sleep(30).then(() => socket.write(id, f.slice(half)));
    });

    await done;
    const ok = bytesEqual(recv, expected);
    if (ok) {
        skynetcore.runtime.error("GATE CLIENT " + tag + " OK " + recv.length + " bytes");
    } else {
        skynetcore.runtime.error("GATE FAIL " + tag + ": echo mismatch (" + recv.length + " vs " + expected.length + ")");
    }
    socket.close(id);
    return ok;
}

skynetcore.runtime.error("MAIN gate test starting");

skynet.start(() => {
    skynet.dispatch("text", (m) => m);
});

// bootstrap async work off a timer so the first worker_cb drains the promises
skynet.timeout(1, async () => {
    const wd = skynet.newservice("snjs test/service/gate-watchdog.js");
    await skynet.call(wd, "lua", skynet.pack("wait_ready", PORT));
    // two concurrent clients exercise independent per-fd reassembly state
    const ok = await Promise.all([runClient("A"), runClient("B")]);
    if (ok.every(Boolean)) {
        skynetcore.runtime.error("GATE_OK 2 clients x 5017 bytes");
    }
});
