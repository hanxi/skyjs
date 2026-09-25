/*
 * Empty static bridge registry (default build). Pure-static mobile builds
 * replace this file with a build-generated one that lists the linked packages;
 * seeing this file means initStatic() always reports an empty table, which is
 * the documented non-error case (node-compatibility §3.4.5).
 */

#include "skyjs-native-registry.h"

int
skyjs_native_static_count(void) {
	return 0;
}

const struct skyjs_static_ext *
skyjs_native_static_at(int index) {
	(void)index;
	return NULL;
}
