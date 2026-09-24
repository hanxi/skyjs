// Legacy loader entry retained for the NC0.7 transition. The implementation
// lives in js/internal/skynet-core.js and is installed by js/bootstrap.js
// before the user service entry. NC0.8 removes this lazy-loader shim.

require("./internal/skynet-core.js");
