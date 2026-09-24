// Task 10 acceptance: io module test orchestration.
// All test artefacts go into build/io_test/ and are cleaned up at the end.
"use strict";

const io = require("../../js/internal/fs-core.js");

const TEST_DIR = "build/io_test";

let failCount = 0;

function check(label, ok, detail) {
    if (ok) {
        console.log("IO " + label + " OK");
    } else {
        console.log("IO FAIL " + label + (detail ? ": " + detail : ""));
        failCount++;
    }
}

function abEq(a, b) {
    if (a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) return false;
    }
    return true;
}

// cleanup helper: remove file if exists, ignore errors
function safeRemove(p) {
    try { if (io.exists(p)) io.remove(p); } catch (_) { /* ignore */ }
}

function safeRmdir(p) {
    try {
        if (io.exists(p)) {
            const entries = io.readdir(p);
            for (let i = 0; i < entries.length; i++) {
                const child = p + "/" + entries[i];
                const s = io.stat(child);
                if (s.isDir) {
                    safeRmdir(child);
                } else {
                    io.remove(child);
                }
            }
            io.remove(p);
        }
    } catch (_) { /* ignore */ }
}

skynet.start(() => {});

skynet.timeout(1, async () => {
    // ensure clean test directory
    safeRmdir(TEST_DIR);
    io.mkdir(TEST_DIR, true);

    try {
        // ---- sync: write_file + read_file binary roundtrip ----
        {
            const src = new Uint8Array([0, 1, 2, 127, 128, 255]);
            const p = TEST_DIR + "/bin.dat";
            io.writeFile(p, src.buffer);
            const back = io.readFile(p);
            check("sync_binary_roundtrip", abEq(src.buffer, back),
                "len=" + back.byteLength);
        }

        // ---- sync: write_file(string) + read_text_file text roundtrip ----
        {
            const text = "hello\nworld\n你好";
            const p = TEST_DIR + "/text.txt";
            io.writeFile(p, text);
            const back = io.readTextFile(p);
            check("sync_text_roundtrip", back === text,
                "got=" + JSON.stringify(back));
        }

        // ---- sync: append_file ----
        {
            const p = TEST_DIR + "/append.txt";
            io.writeFile(p, "AAA");
            io.appendFile(p, "BBB");
            const back = io.readTextFile(p);
            check("sync_append", back === "AAABBB", "got=" + back);
        }

        // ---- sync: exists ----
        {
            const p = TEST_DIR + "/exist_test.txt";
            io.writeFile(p, "x");
            check("exists_true", io.exists(p) === true);
            check("exists_false", io.exists(TEST_DIR + "/no_such_file.xyz") === false);
        }

        // ---- sync: stat file ----
        {
            const p = TEST_DIR + "/stat_file.txt";
            io.writeFile(p, "12345");
            const s = io.stat(p);
            check("stat_file_size", s.size === 5, "size=" + s.size);
            check("stat_is_file", s.isFile === true);
            check("stat_is_dir_false", s.isDir === false);
        }

        // ---- sync: stat directory ----
        {
            const s = io.stat(TEST_DIR);
            check("stat_dir_is_dir", s.isDir === true);
        }

        // ---- sync: mkdir + readdir ----
        {
            const sub = TEST_DIR + "/subdir";
            io.mkdir(sub);
            io.writeFile(sub + "/a.txt", "a");
            io.writeFile(sub + "/b.txt", "b");
            const entries = io.readdir(sub);
            check("readdir", entries.includes("a.txt") && entries.includes("b.txt"),
                "entries=" + JSON.stringify(entries));
        }

        // ---- sync: mkdir recursive ----
        {
            const deep = TEST_DIR + "/x/y/z";
            io.mkdir(deep, true);
            check("mkdir_recursive", io.exists(deep) && io.stat(deep).isDir);
        }

        // ---- sync: rename ----
        {
            const oldP = TEST_DIR + "/rename_src.txt";
            const newP = TEST_DIR + "/rename_dst.txt";
            io.writeFile(oldP, "ren");
            io.rename(oldP, newP);
            check("rename_old_gone", io.exists(oldP) === false);
            check("rename_new_exists", io.exists(newP) === true);
            const back = io.readTextFile(newP);
            check("rename_content", back === "ren", "got=" + back);
        }

        // ---- sync: remove ----
        {
            const p = TEST_DIR + "/remove_me.txt";
            io.writeFile(p, "bye");
            io.remove(p);
            check("remove", io.exists(p) === false);
        }

        // ---- sync: File streaming ----
        {
            const p = TEST_DIR + "/stream.bin";
            const fW = io.open(p, "w");
            fW.write("ABCD");
            fW.write("EFGH");
            fW.close();

            const fR = io.open(p, "r");
            // seek to offset 2, read 4 bytes => "CDEF"
            fR.seek(2, 0);
            const pos = fR.tell();
            check("file_tell", pos === 2, "pos=" + pos);
            const chunk = fR.read(4);
            const chunkStr = skynetcore.seri.str(chunk);
            check("file_seek_read", chunkStr === "CDEF",
                "got=" + JSON.stringify(chunkStr));
            // read remaining => "GH"
            const rest = fR.read(2);
            const restStr = skynetcore.seri.str(rest);
            check("file_read_rest", restStr === "GH",
                "got=" + JSON.stringify(restStr));
            fR.close();
        }

        // ---- async: write_file_async + read_file_async binary roundtrip ----
        {
            const src = new Uint8Array([10, 20, 30, 40, 50]);
            const p = TEST_DIR + "/async_bin.dat";
            await io.writeFileAsync(p, src.buffer);
            const back = await io.readFileAsync(p);
            check("async_binary_roundtrip", abEq(src.buffer, back),
                "len=" + back.byteLength);
        }

        // ---- async: read_text_file_async ----
        {
            const text = "async_hello";
            const p = TEST_DIR + "/async_text.txt";
            io.writeFile(p, text);
            const back = await io.readTextFileAsync(p);
            check("async_text", back === text, "got=" + back);
        }

        // ---- async: stat_async ----
        {
            const p = TEST_DIR + "/async_stat.txt";
            io.writeFile(p, "abc");
            const s = await io.statAsync(p);
            check("async_stat", s.size === 3 && s.isFile === true,
                "size=" + s.size + " is_file=" + s.isFile);
        }

        // ---- error: read_file on non-existent path ----
        {
            let caught = false;
            try {
                io.readFile(TEST_DIR + "/no_such_file_ever.bin");
            } catch (e) {
                caught = true;
            }
            check("error_read_missing", caught, "expected exception");
        }

    } catch (e) {
        console.log("IO FAIL exception: " + (e && (e.message || e)));
        console.log(e && e.stack || "");
        failCount++;
    }

    // cleanup
    safeRmdir(TEST_DIR);

    if (failCount === 0) {
        console.log("IO ALL OK");
    } else {
        console.log("IO FAIL total=" + failCount);
    }
});
