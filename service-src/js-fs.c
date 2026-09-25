/*
 * js-fs.c -- filesystem primitives for SkyJS.
 *
 * Registered as the skynetcore.fs namespace (see register_fs_bridge).
 * Provides whole-file read/write, string<->ArrayBuffer conversion,
 * metadata/directory operations, and streaming FILE* handles wrapped in
 * QuickJS opaque objects with GC-safe finalizers.
 *
 * Errors are structured: every failure throws an Error carrying the Node
 * fields err.code / err.errno / err.syscall / err.path plus
 * err.detail.skyjsCode, so the JS fs facade can re-throw Node-shaped errors
 * without re-parsing message text.
 */

#include <quickjs.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <errno.h>
#include <stdlib.h>

#ifndef _WIN32
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/time.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#endif

#include "skynet.h"
#include "snjs-internal.h"

/* ================================================================
 * Opaque FILE* handle wrapped in a QuickJS class
 * ================================================================ */

/* Map errno to the Node code (see js/internal/errors.js, same table). */
static const char *
fs_errno_code(int e) {
	switch (e) {
	case EPERM: return "EPERM";
	case ENOENT: return "ENOENT";
	case EINTR: return "EINTR";
	case EIO: return "EIO";
	case EBADF: return "EBADF";
	case EAGAIN: return "EAGAIN";
	case ENOMEM: return "ENOMEM";
#ifndef _WIN32
	case EACCES: return "EACCES";
	case EBUSY: return "EBUSY";
	case EEXIST: return "EEXIST";
	case ENOTDIR: return "ENOTDIR";
	case EISDIR: return "EISDIR";
	case EINVAL: return "EINVAL";
	case EMFILE: return "EMFILE";
	case ENFILE: return "ENFILE";
	case ENOSPC: return "ENOSPC";
	case EROFS: return "EROFS";
	case EPIPE: return "EPIPE";
	case ENAMETOOLONG: return "ENAMETOOLONG";
	case ENOTEMPTY: return "ENOTEMPTY";
	case ELOOP: return "ELOOP";
	case ENOSYS: return "ENOSYS";
#endif
	default: return "EIO";
	}
}

static int
fs_errno_value(int e) {
	return e > 0 ? -e : e;
}

static const char *
fs_errno_class(const char *code) {
	if (strcmp(code, "ENOENT") == 0) return "ERR_NOT_FOUND";
	if (strcmp(code, "EACCES") == 0 || strcmp(code, "EPERM") == 0) return "ERR_PERMISSION";
	if (strcmp(code, "EAGAIN") == 0 || strcmp(code, "EBUSY") == 0) return "ERR_BUSY";
	if (strcmp(code, "EMFILE") == 0 || strcmp(code, "ENFILE") == 0 ||
	    strcmp(code, "ENOSPC") == 0) return "ERR_LIMIT_EXCEEDED";
	if (strcmp(code, "EINVAL") == 0 || strcmp(code, "ENAMETOOLONG") == 0) return "ERR_PROTOCOL";
	if (strcmp(code, "ENOSYS") == 0) return "ERR_UNSUPPORTED_PLATFORM";
	if (strcmp(code, "EINTR") == 0) return "ERR_CANCELLED";
	return "ERR_IO";
}

/* Throw an Error carrying Node's errno fields plus err.detail.skyjsCode.
 * `syscall` is the Node API name ("open", "stat", ...); `path` may be NULL. */
static JSValue
fs_throw_errno(JSContext *ctx, const char *syscall, const char *path, int e) {
	const char *code = fs_errno_code(e);
	int errno_value = fs_errno_value(e);
	JSValue err = JS_NewError(ctx);
	char message[512];
	if (path != NULL) {
		snprintf(message, sizeof(message), "%s: %s, %s '%s'",
			code, strerror(e), syscall, path);
	} else {
		snprintf(message, sizeof(message), "%s: %s, %s",
			code, strerror(e), syscall);
	}
	JS_SetPropertyStr(ctx, err, "message", JS_NewString(ctx, message));
	JS_SetPropertyStr(ctx, err, "code", JS_NewString(ctx, code));
	JS_SetPropertyStr(ctx, err, "errno", JS_NewInt32(ctx, errno_value));
	JS_SetPropertyStr(ctx, err, "syscall", JS_NewString(ctx, syscall));
	JS_SetPropertyStr(ctx, err, "path",
		path != NULL ? JS_NewString(ctx, path) : JS_NULL);
	JSValue detail = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, detail, "skyjsCode", JS_NewString(ctx, fs_errno_class(code)));
	JS_SetPropertyStr(ctx, detail, "errno", JS_NewInt32(ctx, errno_value));
	JS_SetPropertyStr(ctx, detail, "syscall", JS_NewString(ctx, syscall));
	JS_SetPropertyStr(ctx, detail, "path",
		path != NULL ? JS_NewString(ctx, path) : JS_NULL);
	JS_SetPropertyStr(ctx, err, "detail", detail);
	return JS_Throw(ctx, err);
}

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
		JSValue err = fs_throw_errno(ctx, "open", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	JSValue ret;
	if (sz < 0) {
		JSValue err = fs_throw_errno(ctx, "read", path, errno ? errno : EIO);
		JS_FreeCString(ctx, path);
		fclose(f);
		return err;
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
		JSValue err = fs_throw_errno(ctx, "open", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	size_t written = fwrite(p, 1, sz, f);
	int write_errno = errno;
	fclose(f);
	if (written != sz) {
		JSValue err = fs_throw_errno(ctx, "write", path,
			write_errno ? write_errno : EIO);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
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
		JSValue err = fs_throw_errno(ctx, "open", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	size_t written = fwrite(p, 1, sz, f);
	int write_errno = errno;
	fclose(f);
	if (written != sz) {
		JSValue err = fs_throw_errno(ctx, "write", path,
			write_errno ? write_errno : EIO);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
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
		JSValue err = fs_throw_errno(ctx, "scandir", path, errno);
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
		JSValue err = fs_throw_errno(ctx, "mkdir", path, errno);
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
		JSValue err = fs_throw_errno(ctx, "unlink", path, errno);
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
		JSValue err = fs_throw_errno(ctx, "rename", old_path, errno);
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
		JSValue err = fs_throw_errno(ctx, "open", path, errno);
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
		return fs_throw_errno(ctx, "lseek", NULL, errno);
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
		return fs_throw_errno(ctx, "lseek", NULL, errno);
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
 * Extended primitives (NC2.3): metadata, sync, link, temp files
 * ================================================================ */

#ifndef _WIN32

/* fs.lstat(path) -> stat object (does not follow symlinks) */
static JSValue js_io_lstat(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	struct stat st;
	if (lstat(path, &st) != 0) {
		JSValue err = fs_throw_errno(ctx, "lstat", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	JSValue obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "size", JS_NewFloat64(ctx, (double)st.st_size));
	JS_SetPropertyStr(ctx, obj, "mtime", JS_NewFloat64(ctx, (double)st.st_mtime));
	JS_SetPropertyStr(ctx, obj, "isDir", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "isFile", JS_NewBool(ctx, S_ISREG(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "isSymbolicLink", JS_NewBool(ctx, S_ISLNK(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "mode", JS_NewInt32(ctx, (int32_t)(st.st_mode & 07777)));
	return obj;
}

/* fs.realpath(path) -> string */
static JSValue js_io_realpath(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	char resolved[4096];
	if (realpath(path, resolved) == NULL) {
		JSValue err = fs_throw_errno(ctx, "realpath", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	return JS_NewString(ctx, resolved);
}

/* fs.chmod(path, mode) -> undefined */
static JSValue js_io_chmod(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	int32_t mode;
	if (JS_ToInt32(ctx, &mode, argv[1])) { JS_FreeCString(ctx, path); return JS_EXCEPTION; }
	if (chmod(path, (mode_t)mode) != 0) {
		JSValue err = fs_throw_errno(ctx, "chmod", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

/* fs.chown(path, uid, gid) -> undefined */
static JSValue js_io_chown(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	int32_t uid, gid;
	if (JS_ToInt32(ctx, &uid, argv[1]) || JS_ToInt32(ctx, &gid, argv[2])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	if (chown(path, (uid_t)uid, (gid_t)gid) != 0) {
		JSValue err = fs_throw_errno(ctx, "chown", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

/* fs.utimes(path, atime, mtime) -> undefined (seconds, float) */
static JSValue js_io_utimes(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	double atime, mtime;
	if (JS_ToFloat64(ctx, &atime, argv[1]) || JS_ToFloat64(ctx, &mtime, argv[2])) {
		JS_FreeCString(ctx, path);
		return JS_EXCEPTION;
	}
	struct timeval times[2];
	times[0].tv_sec = (time_t)atime;
	times[0].tv_usec = (suseconds_t)((atime - (double)times[0].tv_sec) * 1e6);
	times[1].tv_sec = (time_t)mtime;
	times[1].tv_usec = (suseconds_t)((mtime - (double)times[1].tv_sec) * 1e6);
	if (utimes(path, times) != 0) {
		JSValue err = fs_throw_errno(ctx, "utimes", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

/* fs.symlink(target, path) -> undefined */
static JSValue js_io_symlink(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *target = JS_ToCString(ctx, argv[0]);
	if (!target) return JS_EXCEPTION;
	const char *path = JS_ToCString(ctx, argv[1]);
	if (!path) { JS_FreeCString(ctx, target); return JS_EXCEPTION; }
	if (symlink(target, path) != 0) {
		JSValue err = fs_throw_errno(ctx, "symlink", path, errno);
		JS_FreeCString(ctx, target);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, target);
	JS_FreeCString(ctx, path);
	return JS_UNDEFINED;
}

/* fs.readlink(path) -> string */
static JSValue js_io_readlink(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	char target[4096];
	ssize_t n = readlink(path, target, sizeof(target) - 1);
	if (n < 0) {
		JSValue err = fs_throw_errno(ctx, "readlink", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	target[n] = '\0';
	JS_FreeCString(ctx, path);
	return JS_NewString(ctx, target);
}

/* fs.mkdtemp(prefix) -> string (mkstemp + unlink + mkdir) */
static JSValue js_io_mkdtemp(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *prefix = JS_ToCString(ctx, argv[0]);
	if (!prefix) return JS_EXCEPTION;
	char template_path[4096];
	snprintf(template_path, sizeof(template_path), "%sXXXXXX", prefix);
	int fd = mkstemp(template_path);
	if (fd < 0) {
		JSValue err = fs_throw_errno(ctx, "mkdtemp", prefix, errno);
		JS_FreeCString(ctx, prefix);
		return err;
	}
	close(fd);
	if (unlink(template_path) != 0 || mkdir(template_path, 0700) != 0) {
		JSValue err = fs_throw_errno(ctx, "mkdtemp", prefix, errno);
		JS_FreeCString(ctx, prefix);
		return err;
	}
	JS_FreeCString(ctx, prefix);
	return JS_NewString(ctx, template_path);
}

/* fs.statvfs(path) -> { bsize, blocks, bfree, bavail, files, ffree } */
static JSValue js_io_statvfs(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
#if defined(__APPLE__) || defined(__linux__)
	struct statvfs vfs;
	if (statvfs(path, &vfs) != 0) {
		JSValue err = fs_throw_errno(ctx, "statfs", path, errno);
		JS_FreeCString(ctx, path);
		return err;
	}
	JS_FreeCString(ctx, path);
	JSValue obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "bsize", JS_NewFloat64(ctx, (double)vfs.f_bsize));
	JS_SetPropertyStr(ctx, obj, "blocks", JS_NewFloat64(ctx, (double)vfs.f_blocks));
	JS_SetPropertyStr(ctx, obj, "bfree", JS_NewFloat64(ctx, (double)vfs.f_bfree));
	JS_SetPropertyStr(ctx, obj, "bavail", JS_NewFloat64(ctx, (double)vfs.f_bavail));
	JS_SetPropertyStr(ctx, obj, "files", JS_NewFloat64(ctx, (double)vfs.f_files));
	JS_SetPropertyStr(ctx, obj, "ffree", JS_NewFloat64(ctx, (double)vfs.f_ffree));
	return obj;
#else
	JS_FreeCString(ctx, path);
	return fs_throw_errno(ctx, "statfs", NULL, ENOSYS);
#endif
}

/* fs.fstat(handle) -> stat object */
static JSValue js_io_fstat(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "fs.fstat: invalid handle");
#ifndef _WIN32
	struct stat st;
	if (fstat(fileno(ud->fp), &st) != 0)
		return fs_throw_errno(ctx, "fstat", NULL, errno);
	JSValue obj = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, obj, "size", JS_NewFloat64(ctx, (double)st.st_size));
	JS_SetPropertyStr(ctx, obj, "mtime", JS_NewFloat64(ctx, (double)st.st_mtime));
	JS_SetPropertyStr(ctx, obj, "isDir", JS_NewBool(ctx, S_ISDIR(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "isFile", JS_NewBool(ctx, S_ISREG(st.st_mode)));
	JS_SetPropertyStr(ctx, obj, "mode", JS_NewInt32(ctx, (int32_t)(st.st_mode & 07777)));
	return obj;
#else
	return fs_throw_errno(ctx, "fstat", NULL, ENOSYS);
#endif
}

/* fs.ftruncate(handle, len) -> undefined */
static JSValue js_io_ftruncate(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "fs.ftruncate: invalid handle");
	int64_t length;
	if (JS_ToInt64(ctx, &length, argv[1])) return JS_EXCEPTION;
	if (ftruncate(fileno(ud->fp), (off_t)length) != 0)
		return fs_throw_errno(ctx, "ftruncate", NULL, errno);
	return JS_UNDEFINED;
}

/* fs.fsync(handle) -> undefined */
static JSValue js_io_fsync(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "fs.fsync: invalid handle");
	if (fsync(fileno(ud->fp)) != 0)
		return fs_throw_errno(ctx, "fsync", NULL, errno);
	return JS_UNDEFINED;
}

/* fs.fdatasync(handle) -> undefined */
static JSValue js_io_fdatasync(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "fs.fdatasync: invalid handle");
#if defined(__APPLE__)
	if (fsync(fileno(ud->fp)) != 0)
#else
	if (fdatasync(fileno(ud->fp)) != 0)
#endif
		return fs_throw_errno(ctx, "fdatasync", NULL, errno);
	return JS_UNDEFINED;
}

/* fs.futimes(handle, atime, mtime) -> undefined */
static JSValue js_io_futimes(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "fs.futimes: invalid handle");
	double atime, mtime;
	if (JS_ToFloat64(ctx, &atime, argv[1]) || JS_ToFloat64(ctx, &mtime, argv[2]))
		return JS_EXCEPTION;
	struct timeval times[2];
	times[0].tv_sec = (time_t)atime;
	times[0].tv_usec = (suseconds_t)((atime - (double)times[0].tv_sec) * 1e6);
	times[1].tv_sec = (time_t)mtime;
	times[1].tv_usec = (suseconds_t)((mtime - (double)times[1].tv_sec) * 1e6);
	if (futimes(fileno(ud->fp), times) != 0)
		return fs_throw_errno(ctx, "futimes", NULL, errno);
	return JS_UNDEFINED;
}

/* fs.fchmod(handle, mode) -> undefined */
static JSValue js_io_fchmod(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc;
	struct io_file_ud *ud = JS_GetOpaque(argv[0], js_io_file_class_id);
	if (!ud || ud->closed || !ud->fp)
		return JS_ThrowTypeError(ctx, "fs.fchmod: invalid handle");
	int32_t mode;
	if (JS_ToInt32(ctx, &mode, argv[1])) return JS_EXCEPTION;
	if (fchmod(fileno(ud->fp), (mode_t)mode) != 0)
		return fs_throw_errno(ctx, "fchmod", NULL, errno);
	return JS_UNDEFINED;
}

#else /* _WIN32 stubs */

static JSValue js_io_lstat(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "lstat", NULL, ENOSYS);
}
static JSValue js_io_realpath(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "realpath", NULL, ENOSYS);
}
static JSValue js_io_chmod(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "chmod", NULL, ENOSYS);
}
static JSValue js_io_chown(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "chown", NULL, ENOSYS);
}
static JSValue js_io_utimes(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "utimes", NULL, ENOSYS);
}
static JSValue js_io_symlink(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "symlink", NULL, ENOSYS);
}
static JSValue js_io_readlink(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "readlink", NULL, ENOSYS);
}
static JSValue js_io_mkdtemp(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "mkdtemp", NULL, ENOSYS);
}
static JSValue js_io_statvfs(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "statfs", NULL, ENOSYS);
}
static JSValue js_io_ftruncate(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "ftruncate", NULL, ENOSYS);
}
static JSValue js_io_fsync(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "fsync", NULL, ENOSYS);
}
static JSValue js_io_fdatasync(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "fdatasync", NULL, ENOSYS);
}
static JSValue js_io_futimes(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "futimes", NULL, ENOSYS);
}
static JSValue js_io_fchmod(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return fs_throw_errno(ctx, "fchmod", NULL, ENOSYS);
}

#endif /* _WIN32 */

/* ================================================================
 * Registration
 * ================================================================ */

void register_fs_bridge(JSContext *ctx, JSValue global) {
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

	/* extended primitives (NC2.3) */
	JS_SetPropertyStr(ctx, io, "lstat", JS_NewCFunction(ctx, js_io_lstat, "lstat", 1));
	JS_SetPropertyStr(ctx, io, "realpath", JS_NewCFunction(ctx, js_io_realpath, "realpath", 1));
	JS_SetPropertyStr(ctx, io, "chmod", JS_NewCFunction(ctx, js_io_chmod, "chmod", 2));
	JS_SetPropertyStr(ctx, io, "chown", JS_NewCFunction(ctx, js_io_chown, "chown", 3));
	JS_SetPropertyStr(ctx, io, "utimes", JS_NewCFunction(ctx, js_io_utimes, "utimes", 3));
	JS_SetPropertyStr(ctx, io, "symlink", JS_NewCFunction(ctx, js_io_symlink, "symlink", 2));
	JS_SetPropertyStr(ctx, io, "readlink", JS_NewCFunction(ctx, js_io_readlink, "readlink", 1));
	JS_SetPropertyStr(ctx, io, "mkdtemp", JS_NewCFunction(ctx, js_io_mkdtemp, "mkdtemp", 1));
	JS_SetPropertyStr(ctx, io, "statvfs", JS_NewCFunction(ctx, js_io_statvfs, "statvfs", 1));
	JS_SetPropertyStr(ctx, io, "fstat", JS_NewCFunction(ctx, js_io_fstat, "fstat", 1));
	JS_SetPropertyStr(ctx, io, "ftruncate", JS_NewCFunction(ctx, js_io_ftruncate, "ftruncate", 2));
	JS_SetPropertyStr(ctx, io, "fsync", JS_NewCFunction(ctx, js_io_fsync, "fsync", 1));
	JS_SetPropertyStr(ctx, io, "fdatasync", JS_NewCFunction(ctx, js_io_fdatasync, "fdatasync", 1));
	JS_SetPropertyStr(ctx, io, "futimes", JS_NewCFunction(ctx, js_io_futimes, "futimes", 3));
	JS_SetPropertyStr(ctx, io, "fchmod", JS_NewCFunction(ctx, js_io_fchmod, "fchmod", 2));

	JS_SetPropertyStr(ctx, skynetcore, "fs", io);
	JS_FreeValue(ctx, skynetcore);
}
