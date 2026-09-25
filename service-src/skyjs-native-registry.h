#ifndef SKYJS_NATIVE_REGISTRY_H
#define SKYJS_NATIVE_REGISTRY_H

/*
 * Static C bridge registry. In a normal (dynamic) build this header is paired
 * with an empty implementation emitted by the build; pure-static builds (mobile
 * AAR/XCFramework) generate native-registry.c with the packages linked in at
 * build time. The table is read by skynetcore.native.initStatic().
 */

#include <quickjs.h>
#include "skyjs-ext.h"

struct skyjs_static_ext {
	const char *name;               // full package name (e.g. "@skyjs/example-native")
	skyjs_ext_abi_fn abi_fn;        // symbol-renamed per package at build time
	skyjs_ext_init_fn init_fn;
};

int skyjs_native_static_count(void);
const struct skyjs_static_ext *skyjs_native_static_at(int index);

#endif /* SKYJS_NATIVE_REGISTRY_H */
