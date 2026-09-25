#ifndef SKYJS_EXT_H
#define SKYJS_EXT_H

/*
 * Public header for third-party C bridge modules (docs/node-compatibility.md
 * §3.4). An extension exports exactly two symbols:
 *
 *   int    skyjs_ext_abi(void);                              // ABI version
 *   JSValue skyjs_ext_init(JSContext *ctx, JSValueConst ns);  // attach + return
 *
 * The only symbols the runtime ever resolves are these two fixed names, so the
 * bridge is not a generic FFI surface (§3.5).
 */

#include <quickjs.h>

#define SKYJS_EXT_ABI_VERSION 1

#if defined(_WIN32)
#define SKYJS_EXT_EXPORT __declspec(dllexport)
#else
#define SKYJS_EXT_EXPORT __attribute__((visibility("default")))
#endif

typedef int (*skyjs_ext_abi_fn)(void);
typedef JSValue (*skyjs_ext_init_fn)(JSContext *ctx, JSValueConst ns);

#endif /* SKYJS_EXT_H */
