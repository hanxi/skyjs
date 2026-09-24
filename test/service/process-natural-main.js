"use strict";

skynetcore.error("PROCESS_NATURAL_START");
setTimeout(() => {
    process.exitCode = 7;
    skynetcore.command("ABORT");
}, 10);
