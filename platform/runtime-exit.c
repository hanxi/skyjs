/*
 * Process exit-code slot shared by the host (platform/main.c) and the snjs
 * cservice (service-src/js-runtime.c). Kept in its own translation unit so the
 * executable does not depend on symbols exported by a dlopen(RTLD_LOCAL)
 * module on macOS.
 */

#include "atomic.h"

#define MODAPI __attribute__((visibility("default")))

static ATOM_INT runtime_exit_code;
static ATOM_INT runtime_exit_code_set;

MODAPI void
skyjs_runtime_set_exit_code(int code) {
	ATOM_STORE(&runtime_exit_code, code);
	ATOM_STORE(&runtime_exit_code_set, 1);
}

MODAPI int
skyjs_runtime_get_exit_code(void) {
	if (!ATOM_LOAD(&runtime_exit_code_set)) return 0;
	return ATOM_LOAD(&runtime_exit_code);
}
