/*
 * js-native.c -- third-party C bridge loader primitives (NATIVE_EXT=1).
 *
 * Registered as skynetcore.native. Deliberately narrow: the only symbols ever
 * resolved are the fixed names skyjs_ext_abi / skyjs_ext_init, so this is not a
 * generic FFI surface (node-compatibility §3.5, ND-30). Handles are process-wide
 * and shared with a per-service reference count; JSValue results belong to the
 * calling service and must never be cached in extension globals.
 *
 * Without NATIVE_EXT=1 the bridge is not compiled at all and skynetcore.native
 * does not exist; the loader then reports ERR_UNSUPPORTED_PLATFORM for packages
 * declaring skyjs.native.
 */

#include "skynet.h"
#include "snjs-internal.h"

#include <quickjs.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "skynet_malloc.h"

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#include <limits.h>
#include <sys/stat.h>
#endif

#include "skyjs-ext.h"
#include "skyjs-native-registry.h"

#define MAX_EXT 32
#define MAX_ERR 256
#define MAX_PATH_LEN 4096

typedef int (*skyjs_ext_abi_fn)(void);
typedef JSValue (*skyjs_ext_init_fn)(JSContext *ctx, JSValueConst ns);

struct native_ext {
	char *path;              // process-wide key (canonical when possible)
	void *handle;            // dlopen handle (NULL for static entries)
	int refs;                // service references still held
};

static struct native_ext exts[MAX_EXT];
static char last_error[MAX_ERR];

static void
set_error(const char *fmt, const char *arg) {
	if (arg != NULL) snprintf(last_error, sizeof(last_error), fmt, arg);
	else snprintf(last_error, sizeof(last_error), "%s", fmt);
}

static void
clear_error(void) {
	last_error[0] = '\0';
}

static void *
open_library(const char *path) {
#if defined(_WIN32)
	return (void *)LoadLibraryA(path);
#else
	return dlopen(path, RTLD_NOW | RTLD_LOCAL);
#endif
}

static void *
library_symbol(void *handle, const char *name) {
#if defined(_WIN32)
	return (void *)GetProcAddress((HMODULE)handle, name);
#else
	return dlsym(handle, name);
#endif
}

static void
close_library(void *handle) {
	if (handle == NULL) return;
#if defined(_WIN32)
	FreeLibrary((HMODULE)handle);
#else
	dlclose(handle);
#endif
}

static int
file_is_regular(const char *path) {
#if defined(_WIN32)
	DWORD attr = GetFileAttributesA(path);
	return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
#else
	struct stat st;
	return stat(path, &st) == 0 && S_ISREG(st.st_mode);
#endif
}

/* Canonical key for handle sharing; falls back to the raw path. */
static int
canonical_key(const char *path, char *out, size_t outsz) {
#if defined(_WIN32)
	DWORD n = GetFullPathNameA(path, (DWORD)outsz, out, NULL);
	if (n > 0 && n < outsz) return 1;
	snprintf(out, outsz, "%s", path);
	return 1;
#else
	if (realpath(path, out) != NULL) return 1;
	snprintf(out, outsz, "%s", path);
	return 1;
#endif
}

static struct native_ext *
find_entry(const char *key) {
	for (int i = 0; i < MAX_EXT; i++) {
		if (exts[i].path != NULL && strcmp(exts[i].path, key) == 0) {
			return &exts[i];
		}
	}
	return NULL;
}

/* ---------------------------------------------------------------- primitives */

static JSValue
js_native_enabled(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_TRUE;
}

static JSValue
js_native_static_enabled(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_NewBool(ctx, skyjs_native_static_count() > 0);
}

/* native.dynamicEnabled() -> extpath non-empty */
static JSValue
js_native_dynamic_enabled(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	struct snjs *l = JS_GetContextOpaque(ctx);
	const char *extpath = skynet_command(l->ctx, "GETENV", "extpath");
	return JS_NewBool(ctx, extpath != NULL && extpath[0] != '\0');
}

/* native.resolve(pkgRoot, relPath) -> absolute path | null */
static JSValue
js_native_resolve(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	if (argc < 2) return JS_NULL;
	const char *root = JS_ToCString(ctx, argv[0]);
	if (root == NULL) return JS_EXCEPTION;
	const char *rel = JS_ToCString(ctx, argv[1]);
	if (rel == NULL) { JS_FreeCString(ctx, root); return JS_EXCEPTION; }

	char out[MAX_PATH_LEN];
	clear_error();
	int ok = 0;
	if (rel[0] == '/') {
		set_error("native.resolve: absolute path denied: %s", rel);
	} else if (strstr(rel, "..") != NULL) {
		set_error("native.resolve: path escapes package root: %s", rel);
	} else if (strlen(root) + strlen(rel) + 2 >= sizeof(out)) {
		set_error("native.resolve: path too long", NULL);
	} else {
		snprintf(out, sizeof(out), "%s/%s", root, rel);
		if (!file_is_regular(out)) {
			set_error("native.resolve: not a regular file: %s", out);
		} else {
			ok = 1;
		}
	}
	JS_FreeCString(ctx, root);
	JS_FreeCString(ctx, rel);
	return ok ? JS_NewString(ctx, out) : JS_NULL;
}

#if !defined(_WIN32)
static const char *NATIVE_LIBEXT = "dylib";
#elif defined(_WIN32)
static const char *NATIVE_LIBEXT = "dll";
#else
static const char *NATIVE_LIBEXT = "so";
#endif

/* native.find(pkgName, platform, arch) -> path | null (extpath fallback) */
static JSValue
js_native_find(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	if (argc < 3) return JS_NULL;
	const char *pkg = JS_ToCString(ctx, argv[0]);
	if (pkg == NULL) return JS_EXCEPTION;
	const char *platform = JS_ToCString(ctx, argv[1]);
	if (platform == NULL) { JS_FreeCString(ctx, pkg); return JS_EXCEPTION; }
	const char *arch = JS_ToCString(ctx, argv[2]);
	if (arch == NULL) {
		JS_FreeCString(ctx, pkg);
		JS_FreeCString(ctx, platform);
		return JS_EXCEPTION;
	}
	struct snjs *l = JS_GetContextOpaque(ctx);
	const char *extpath = skynet_command(l->ctx, "GETENV", "extpath");

	/* package short name: strip a leading scope */
	const char *shortname = strrchr(pkg, '/');
	shortname = shortname == NULL ? pkg : shortname + 1;

	JSValue result = JS_NULL;
	if (extpath != NULL && extpath[0] != '\0') {
		char roots[MAX_PATH_LEN];
		snprintf(roots, sizeof(roots), "%s", extpath);
		for (char *root = strtok(roots, ";"); root != NULL;
		     root = strtok(NULL, ";")) {
			char candidate[MAX_PATH_LEN];
			snprintf(candidate, sizeof(candidate), "%s/%s/%s-%s/%s.%s",
				root, shortname, platform, arch, shortname, NATIVE_LIBEXT);
			if (file_is_regular(candidate)) {
				result = JS_NewString(ctx, candidate);
				goto done;
			}
			snprintf(candidate, sizeof(candidate), "%s/%s.%s",
				root, shortname, NATIVE_LIBEXT);
			if (file_is_regular(candidate)) {
				result = JS_NewString(ctx, candidate);
				goto done;
			}
		}
	}
done:
	JS_FreeCString(ctx, pkg);
	JS_FreeCString(ctx, platform);
	JS_FreeCString(ctx, arch);
	return result;
}

/* native.load(path) -> handle | null */
static JSValue
js_native_load(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	if (argc < 1) return JS_NULL;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (path == NULL) return JS_EXCEPTION;

	char key[MAX_PATH_LEN];
	canonical_key(path, key, sizeof(key));

	struct native_ext *entry = find_entry(key);
	if (entry != NULL) {
		entry->refs++;
		JS_FreeCString(ctx, path);
		return JS_NewInt32(ctx, (int32_t)(entry - exts));
	}

	int slot = -1;
	for (int i = 0; i < MAX_EXT; i++) {
		if (exts[i].path == NULL) { slot = i; break; }
	}
	if (slot < 0) {
		set_error("native.load: extension table full", NULL);
		JS_FreeCString(ctx, path);
		return JS_NULL;
	}

	void *handle = open_library(path);
	if (handle == NULL) {
		set_error("native.load: cannot open %s", path);
		JS_FreeCString(ctx, path);
		return JS_NULL;
	}
	exts[slot].path = skynet_malloc(strlen(key) + 1);
	if (exts[slot].path == NULL) {
		close_library(handle);
		set_error("native.load: out of memory", NULL);
		JS_FreeCString(ctx, path);
		return JS_NULL;
	}
	memcpy(exts[slot].path, key, strlen(key) + 1);
	exts[slot].handle = handle;
	exts[slot].refs = 1;
	clear_error();
	JS_FreeCString(ctx, path);
	return JS_NewInt32(ctx, (int32_t)slot);
}

static struct native_ext *
entry_from_handle(int32_t h) {
	if (h < 0 || h >= MAX_EXT) return NULL;
	if (exts[h].path == NULL) return NULL;
	return &exts[h];
}

/* native.abi(handle) -> int (0 on failure; errmsg() explains) */
static JSValue
js_native_abi(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t h = 0;
	if (argc < 1 || JS_ToInt32(ctx, &h, argv[0])) return JS_EXCEPTION;
	struct native_ext *entry = entry_from_handle(h);
	if (entry == NULL) {
		set_error("native.abi: invalid handle", NULL);
		return JS_NewInt32(ctx, 0);
	}
	skyjs_ext_abi_fn abi = (skyjs_ext_abi_fn)library_symbol(entry->handle, "skyjs_ext_abi");
	if (abi == NULL) {
		set_error("native.abi: skyjs_ext_abi symbol missing", NULL);
		return JS_NewInt32(ctx, 0);
	}
	clear_error();
	return JS_NewInt32(ctx, abi());
}

/* native.init(handle, ns) -> exports */
static JSValue
js_native_init(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t h = 0;
	if (argc < 1 || JS_ToInt32(ctx, &h, argv[0])) return JS_EXCEPTION;
	struct native_ext *entry = entry_from_handle(h);
	if (entry == NULL) {
		set_error("native.init: invalid handle", NULL);
		return JS_ThrowInternalError(ctx, "native.init: invalid handle");
	}
	skyjs_ext_init_fn init = (skyjs_ext_init_fn)library_symbol(entry->handle,
		"skyjs_ext_init");
	if (init == NULL) {
		set_error("native.init: skyjs_ext_init symbol missing", NULL);
		return JS_ThrowInternalError(ctx, "native.init: skyjs_ext_init symbol missing");
	}
	JSValue ns = argc > 1 ? argv[1] : JS_UNDEFINED;
	clear_error();
	return init(ctx, ns);
}

/* native.initStatic(pkgName, ns) -> exports | null */
static JSValue
js_native_init_static(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	if (argc < 1) return JS_NULL;
	const char *pkg = JS_ToCString(ctx, argv[0]);
	if (pkg == NULL) return JS_EXCEPTION;
	JSValue ns = argc > 1 ? argv[1] : JS_UNDEFINED;
	JSValue out = JS_NULL;

	for (int i = 0; i < skyjs_native_static_count(); i++) {
		const struct skyjs_static_ext *entry = skyjs_native_static_at(i);
		if (entry == NULL || entry->name == NULL) continue;
		if (strcmp(entry->name, pkg) != 0) continue;
		if (entry->abi_fn != NULL && entry->abi_fn() != SKYJS_EXT_ABI_VERSION) {
			set_error("native.initStatic: ABI mismatch", NULL);
			break;
		}
		if (entry->init_fn != NULL) out = entry->init_fn(ctx, ns);
		break;
	}
	JS_FreeCString(ctx, pkg);
	return out;
}

/* native.unload(handle) -> undefined */
static JSValue
js_native_unload(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t h = 0;
	if (argc < 1 || JS_ToInt32(ctx, &h, argv[0])) return JS_EXCEPTION;
	struct native_ext *entry = entry_from_handle(h);
	if (entry == NULL) return JS_UNDEFINED;
	entry->refs--;
	if (entry->refs <= 0) {
		close_library(entry->handle);
		skynet_free(entry->path);
		entry->path = NULL;
		entry->handle = NULL;
		entry->refs = 0;
	}
	return JS_UNDEFINED;
}

static JSValue
js_native_errmsg(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_NewString(ctx, last_error);
}

/* ------------------------------------------------------------------ bridge */

void
register_native_bridge(JSContext *ctx, JSValue obj) {
	JSValue native = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, native, "enabled",
		JS_NewCFunction(ctx, js_native_enabled, "enabled", 0));
	JS_SetPropertyStr(ctx, native, "dynamicEnabled",
		JS_NewCFunction(ctx, js_native_dynamic_enabled, "dynamicEnabled", 0));
	JS_SetPropertyStr(ctx, native, "staticEnabled",
		JS_NewCFunction(ctx, js_native_static_enabled, "staticEnabled", 0));
	JS_SetPropertyStr(ctx, native, "resolve",
		JS_NewCFunction(ctx, js_native_resolve, "resolve", 2));
	JS_SetPropertyStr(ctx, native, "find",
		JS_NewCFunction(ctx, js_native_find, "find", 3));
	JS_SetPropertyStr(ctx, native, "load",
		JS_NewCFunction(ctx, js_native_load, "load", 1));
	JS_SetPropertyStr(ctx, native, "abi",
		JS_NewCFunction(ctx, js_native_abi, "abi", 1));
	JS_SetPropertyStr(ctx, native, "init",
		JS_NewCFunction(ctx, js_native_init, "init", 2));
	JS_SetPropertyStr(ctx, native, "initStatic",
		JS_NewCFunction(ctx, js_native_init_static, "initStatic", 2));
	JS_SetPropertyStr(ctx, native, "unload",
		JS_NewCFunction(ctx, js_native_unload, "unload", 1));
	JS_SetPropertyStr(ctx, native, "errmsg",
		JS_NewCFunction(ctx, js_native_errmsg, "errmsg", 0));
	JS_SetPropertyStr(ctx, obj, "native", native);
}

/* Per-service teardown: release this service's references. */
void
js_native_release_all(void) {
	for (int i = 0; i < MAX_EXT; i++) {
		if (exts[i].path == NULL) continue;
		exts[i].refs = 0;
		close_library(exts[i].handle);
		skynet_free(exts[i].path);
		exts[i].path = NULL;
		exts[i].handle = NULL;
	}
}
