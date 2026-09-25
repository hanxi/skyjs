// js/skyjs.d.ts -- aggregate ambient declaration for the SkyJS runtime.
//
// NC0.8 split the surface into js/types/*.d.ts. This file keeps the historical
// include path (examples/ts-echo references it) working; the legacy
// io/socket/crypt/cluster/... globals were removed from the runtime, so their
// declarations are gone too.

/// <reference path="./types/core.d.ts" />
/// <reference path="./types/buffer.d.ts" />
/// <reference path="./types/skyjs-log.d.ts" />
/// <reference path="./types/skyjs-testing.d.ts" />
/// <reference path="./types/net.d.ts" />
/// <reference path="./types/tls.d.ts" />
/// <reference path="./types/http.d.ts" />
/// <reference path="./types/fetch.d.ts" />
/// <reference path="./types/crypto.d.ts" />
/// <reference path="./types/zlib.d.ts" />
