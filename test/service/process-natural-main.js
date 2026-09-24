"use strict";

skynetcore.runtime.error("PROCESS_NATURAL_START");
setTimeout(() => {
    process.exitCode = 7;
    skynetcore.runtime.command("ABORT");
}, 10);
