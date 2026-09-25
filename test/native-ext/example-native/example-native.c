/*
 * Test/demo C bridge extension used by the NC5 acceptance scenario.
 * Registered as a package with skyjs.native; only the two fixed entry symbols
 * are exported.
 */

#include "skyjs-ext.h"

#include <stdint.h>
#include <string.h>

static JSValue
js_example_crc32(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val;
	if (argc < 1) return JS_ThrowTypeError(ctx, "crc32(buffer)");
	size_t len = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &len, argv[0]);
	if (p == NULL) return JS_EXCEPTION;
	uint32_t crc = 0xffffffffu;
	for (size_t i = 0; i < len; i++) {
		crc ^= p[i];
		for (int b = 0; b < 8; b++) {
			crc = (crc >> 1) ^ (0xedb88320u & (uint32_t)(-(int32_t)(crc & 1)));
		}
	}
	return JS_NewUint32(ctx, crc ^ 0xffffffffu);
}

static JSValue
js_example_abi_probe(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc; (void)argv;
	return JS_NewInt32(ctx, SKYJS_EXT_ABI_VERSION);
}

SKYJS_EXT_EXPORT int
skyjs_ext_abi(void) {
	return SKYJS_EXT_ABI_VERSION;
}

SKYJS_EXT_EXPORT JSValue
skyjs_ext_init(JSContext *ctx, JSValueConst ns) {
	JS_SetPropertyStr(ctx, ns, "crc32",
		JS_NewCFunction(ctx, js_example_crc32, "crc32", 1));
	JS_SetPropertyStr(ctx, ns, "abiProbe",
		JS_NewCFunction(ctx, js_example_abi_probe, "abiProbe", 0));
	return JS_DupValue(ctx, ns);
}
