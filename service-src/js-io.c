/*
 * js-io.c -- File I/O primitives for SkyJS.
 *
 * Registered as skynetcore.io namespace (see register_io_bridge).
 * Provides whole-file read/write, string↔ArrayBuffer conversion,
 * stat/readdir/mkdir/remove/rename, and streaming FILE* handles
 * wrapped in QuickJS opaque objects with GC-safe finalizers.
 */

#include <quickjs.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>

#ifndef _WIN32
#include <sys/stat.h>
#include <dirent.h>
#include <unistd.h>
#endif

#include "skynet.h"
#include "snjs-internal.h"

/* ================================================================
 * Opaque FILE* handle wrapped in a QuickJS class
 * ================================================================ */

struct io_file_ud {
	FILE *fp;
	int closed;
};

static JSClassID js_io_file_class_id = 0;

static void io_file_finalizer(JSRuntime *rt, JSValue val) {
	(void)rt;
	struct io_file_ud *ud = JS_GetOpaque(val, js_io_file_class_id);
	if (ud && !ud->closed && ud->fp) {
		fclose(ud->fp);
		ud->fp = NULL;
		ud->closed = 1;
	}
}

static JSClassDef js_io_file_class = {
	"IOFile",
	.finalizer = io_file_finalizer,
};

/* ================================================================
 * Whole-file read/write
 * ================================================================ */

/* io.read_file(path) -> ArrayBuffer */
static JSValue js_io_read_file(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	FILE *f = fopen(path, "rb");
	if (!f) {
		JSValue err = JS_ThrowTypeError(ctx, "io.read_file: can't open %s", path);
		JS_FreeCString(ctx, path);
		return err;
	}
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	JSValue ret;
	if (sz < 0) {
		ret = JS_ThrowTypeError(ctx, "io.read_file: ftell failed for %s", path);
	} else {
		uint8_t *buf = skynet_malloc((size_t)sz);
		size_t rd = fread(buf, 1, (size_t)sz, f);
		ret = JS_NewArrayBufferCopy(ctx, buf, rd);
		skynet_free(buf);
	}
	fclose(f);
	JS_FreeCString(ctx, path);
	return ret;
}

/* io.write_file(path, ab) -> undefined ("wb" overwrite) */
static JSValue js_io_write_file(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[1]);
	if (!p) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	FILE *f = fopen(path, "wb");
	if (!f) {
		JSValue err = JS_ThrowTypeError(ctx, "io.write_file: can't write %s", path);
		JS_FreeCString(ctx, path);
		return err;
	}
	size_t written = fwrite(p, 1, sz, f);
	fclose(f);
	JS_FreeCString(ctx, path);
	if (written != sz)
		return JS_ThrowInternalError(ctx, "io.write_file: incomplete write");
	return JS_UNDEFINED;
}

/* io.append_file(path, ab) -> undefined ("ab" append) */
static JSValue js_io_append_file(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[1]);
	if (!p) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	FILE *f = fopen(path, "ab");
	if (!f) {
		JSValue err = JS_ThrowTypeError(ctx, "io.append_file: can't open %s for append", path);
		JS_FreeCString(ctx, path);
		return err;
	}
	size_t written = fwrite(p, 1, sz, f);
	fclose(f);
	JS_FreeCString(ctx, path);
	if (written != sz)
		return JS_ThrowInternalError(ctx, "io.append_file: incomplete write");
	return JS_UNDEFINED;
}

/* ================================================================
 * String conversion
 * ================================================================ */

/* io.str2ab(string) -> ArrayBuffer */
static JSValue js_io_str2ab(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	size_t len = 0;
	const char *s = JS_ToCStringLen(ctx, &len, argv[0]);
	if (!s) return JS_EXCEPTION;
	JSValue ret = JS_NewArrayBufferCopy(ctx, (const uint8_t *)s, len);
	JS_FreeCString(ctx, s);
	return ret;
}

/* ================================================================
 * Metadata / directory operations
 * ================================================================ */

#ifndef _WIN32

/* io.exists(path) -> boolean */
static JSValue js_io_exists(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	struct stat st;
	int ok = (stat(path, &st) == 0);
	JS_FreeCString(ctx, path);
	return JS_NewBool(ctx, ok);
}

/* io.stat(path) -> { size, mtime, is_dir, is_file, mode } or null */
static JSValue js_io_stat(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	struct stat st;
	if (stat(path, &st) != 0) {
		JS_FreeCString(ctx, path);
		return JS_NULL;
	}
	JS_FreeCString(ctx, path);
	JSValue obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "size", JS_NewFloat64(ctx, (double)st.st_size));
	JS_SetPropertyStr(ctx, obj, "mtime", JS_NewFloat64(ctx, (double)st.st_mtime));
	JS_SetPropertyStr(ctx, obj, "isDir", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "isFile", JS_NewBool(ctx, S_ISREG(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "mode", JS_NewInt32(ctx, (int32_t)(st.st_mode & 07777)));
	return obj;
}

/* io.readdir(path) -> string[] (skips "." and "..") */
static JSValue js_io_readdir(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	DIR *d = opendir(path);
	if (!d) {
		JSValue err = JS_ThrowTypeError(ctx, "io.readdir: can't open directory %s", path);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	JSValue arr = JS_NewArray(ctx);
	uint32_t idx = 0;
	struct dirent *ent;
	while ((ent = readdir(d)) != NULL) {
		if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0)
			continue;
		JS_SetPropertyUint32(ctx, arr, idx++, JS_NewString(ctx, ent->d_name));
	}
	closedir(d);
	return arr;
}

/* io.mkdir(path) -> undefined (EEXIST is not an error) */
static JSValue js_io_mkdir(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	if (mkdir(path, 0755) != 0 && errno != EEXIST) {
		JSValue err = JS_ThrowTypeError(ctx, "io.mkdir: failed to create %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

/* io.remove(path) -> undefined */
static JSValue js_io_remove(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	if (remove(path) != 0) {
		JSValue err = JS_ThrowTypeError(ctx, "io.remove: failed to remove %s: %s", path, strerror(errno));
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

/* io.rename(old_path, new_path) -> undefined */
static JSValue js_io_rename(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *old_path = JS_ToCString(ctx, argv[0]);
	if (!old_path) return JS_EXCEPTION;
	const char *new_path = JS_ToCString(ctx, argv[1]);
	if (!new_path) {
		JS_FreeCString(ctx, old_path);
		return JS_EXCEPTION;
	}
	if (rename(old_path, new_path) != 0) {
		JSValue err = JS_ThrowTypeError(ctx, "io.rename: failed to rename %s -> %s: %s",
			old_path, new_path, strerror(errno));
		JS_FreeCString(ctx, old_path);
		JS_FreeCString(ctx, new_path);
		return err;
	}
	JS_FreeCString(ctx, old_path);
	JS_FreeCString(ctx, new_path);
	return JS_UNDEFINED;
}

#else /* _WIN32 */

static JSValue js_io_exists(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "io.exists: not supported on this platform");
}
static JSValue js_io_stat(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "io.stat: not supported on this platform");
}
static JSValue js_io_readdir(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "io.readdir: not supported on this platform");
}
static JSValue js_io_mkdir(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "io.mkdir: not supported on this platform");
}
static JSValue js_io_remove(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "io.remove: not supported on this platform");
}
static JSValue js_io_rename(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowTypeError(ctx, "io.rename: not supported on this platform");
}

#endif /* _WIN32 */

/* ================================================================
 * Streaming FILE* handle operations
 * ================================================================ */

/* io.open(path, mode) -> handle object
 * mode is "r"/"w"/"a"/"r+"/"w+"; we auto-append "b" for binary. */
static JSValue js_io_open(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	const char *mode = JS_ToCString(ctx, argv[1]);
	if (!mode) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	/* build binary mode string: append 'b' if not already present */
	char bmode[8];
	size_t mlen = strlen(mode);
	if (mlen >= sizeof(bmode) - 1) {
		JS_FreeCString(ctx, path);
		JS_FreeCString(ctx, mode);
		return JS_ThrowTypeError(ctx, "io.open: mode string too long");
	}
	memcpy(bmode, mode, mlen);
	if (mlen == 0 || (mode[mlen - 1] != 'b' && !(mlen >= 2 && mode[mlen - 2] == 'b'))) {
		bmode[mlen] = 'b';
		bmode[mlen + 1] = '\0';
	} else {
		bmode[mlen] = '\0';
	}
	JS_FreeCString(ctx, mode);

	FILE *fp = fopen(path, bmode);
	if (!fp) {
		JSValue err = JS_ThrowTypeError(ctx, "io.open: can't open %s with mode %s", path, bmode);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);

	struct io_file_ud *ud = js_mallocz(ctx, sizeof(*ud));
	if (!ud) {
		fclose(fp);
		return JS_EXCEPTION;
	}
	ud->fp = fp;
	ud->closed = 0;

	JSValue obj = JS_NewObjectClass(ctx, js_io_file_class_id);
	if (JS_IsException(obj)) {
		fclose(fp);
		js_free(ctx, ud);
		return JS_EXCEPTION;
	}
	JS_SetOpaque(obj, ud);
	return obj;
}

/* io.fread(handle, n) -> ArrayBuffer */
static JSValue js_io_fread(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "io.fread: invalid handle");
	int32_t n;
	if (JS_ToInt32(ctx, &n, argv[1])) return JS_EXCEPTION;
	if (n <= 0) return JS_NewArrayBufferCopy(ctx, NULL, 0);

	uint8_t *buf = skynet_malloc((size_t)n);
	size_t rd = fread(buf, 1, (size_t)n, ud->fp);
	JSValue ret = JS_NewArrayBufferCopy(ctx, buf, rd);
	skynet_free(buf);
	return ret;
}

/* io.fwrite(handle, ab) -> number (bytes actually written) */
static JSValue js_io_fwrite(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "io.fwrite: invalid handle");
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[1]);
	if (!p) return JS_EXCEPTION;
	size_t written = fwrite(p, 1, sz, ud->fp);
	return JS_NewInt64(ctx, (int64_t)written);
}

/* io.fseek(handle, offset, whence) -> undefined
 * whence: 0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END */
static JSValue js_io_fseek(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "io.fseek: invalid handle");
	int64_t offset;
	int32_t whence;
	if (JS_ToInt64(ctx, &offset, argv[1])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &whence, argv[2])) return JS_EXCEPTION;
	int w;
	switch (whence) {
	case 0: w = SEEK_SET; break;
	case 1: w = SEEK_CUR; break;
	case 2: w = SEEK_END; break;
	default:
		return JS_ThrowTypeError(ctx, "io.fseek: invalid whence %d", whence);
	}
	if (fseek(ud->fp, (long)offset, w) != 0)
		return JS_ThrowTypeError(ctx, "io.fseek: fseek failed: %s", strerror(errno));
	return JS_UNDEFINED;
}

/* io.ftell(handle) -> number */
static JSValue js_io_ftell(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "io.ftell: invalid handle");
	long pos = ftell(ud->fp);
	if (pos < 0)
		return JS_ThrowTypeError(ctx, "io.ftell: ftell failed: %s", strerror(errno));
	return JS_NewInt64(ctx, (int64_t)pos);
}

/* io.fclose(handle) -> undefined (idempotent) */
static JSValue js_io_fclose(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud) return JS_UNDEFINED;
	if (!ud->closed && ud->fp) {
		fclose(ud->fp);
		ud->fp = NULL;
		ud->closed = 1;
	}
	return JS_UNDEFINED;
}

/* ================================================================
 * Registration
 * ================================================================ */

void register_io_bridge(JSContext *ctx, JSValue global) {
	/* Register the opaque FILE* class */
	JS_NewClassID(JS_GetRuntime(ctx), &js_io_file_class_id);
	JS_NewClass(JS_GetRuntime(ctx), js_io_file_class_id, &js_io_file_class);

	JSValue skynetcore = JS_GetPropertyStr(ctx, global, "skynetcore");
	JSValue io = JS_NewObject(ctx);

	/* whole-file read/write */
	JS_SetPropertyStr(ctx, io, "readFile", JS_NewCFunction(ctx, js_io_read_file, "readFile", 1));
	JS_SetPropertyStr(ctx, io, "writeFile", JS_NewCFunction(ctx, js_io_write_file, "writeFile", 2));
	JS_SetPropertyStr(ctx, io, "appendFile", JS_NewCFunction(ctx, js_io_append_file, "appendFile", 2));

	/* string conversion */
	JS_SetPropertyStr(ctx, io, "str2ab", JS_NewCFunction(ctx, js_io_str2ab, "str2ab", 1));

	/* metadata / directory */
	JS_SetPropertyStr(ctx, io, "exists", JS_NewCFunction(ctx, js_io_exists, "exists", 1));
	JS_SetPropertyStr(ctx, io, "stat", JS_NewCFunction(ctx, js_io_stat, "stat", 1));
	JS_SetPropertyStr(ctx, io, "readdir", JS_NewCFunction(ctx, js_io_readdir, "readdir", 1));
	JS_SetPropertyStr(ctx, io, "mkdir", JS_NewCFunction(ctx, js_io_mkdir, "mkdir", 1));
	JS_SetPropertyStr(ctx, io, "remove", JS_NewCFunction(ctx, js_io_remove, "remove", 1));
	JS_SetPropertyStr(ctx, io, "rename", JS_NewCFunction(ctx, js_io_rename, "rename", 2));

	/* streaming handle */
	JS_SetPropertyStr(ctx, io, "open", JS_NewCFunction(ctx, js_io_open, "open", 2));
	JS_SetPropertyStr(ctx, io, "fread", JS_NewCFunction(ctx, js_io_fread, "fread", 2));
	JS_SetPropertyStr(ctx, io, "fwrite", JS_NewCFunction(ctx, js_io_fwrite, "fwrite", 2));
	JS_SetPropertyStr(ctx, io, "fseek", JS_NewCFunction(ctx, js_io_fseek, "fseek", 3));
	JS_SetPropertyStr(ctx, io, "ftell", JS_NewCFunction(ctx, js_io_ftell, "ftell", 1));
	JS_SetPropertyStr(ctx, io, "fclose", JS_NewCFunction(ctx, js_io_fclose, "fclose", 1));

	JS_SetPropertyStr(ctx, skynetcore, "fs", io);
	JS_FreeValue(ctx, skynetcore);
}
