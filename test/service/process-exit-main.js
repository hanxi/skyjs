"use strict";

skynetcore.error("PROCESS_EXIT_START");
setTimeout(() => {
    try {
        process.exit(3);
    } catch (err) {
        // QuickJS has no non-catchable exception: the sentinel can be observed
        // here, but the exit code must already be committed.
        if (!err || err.code !== "__skyjsProcessExit") throw err;
    }
}, 10);
