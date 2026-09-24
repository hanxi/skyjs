/*
 * js-runtime.c -- skynetcore.runtime primitives.
 *
 * This file owns the runtime capability namespace only. Other flat
 * skynetcore names are still registered by snjs.c during the NC0 transition;
 * grouping them into fs/net/seri happens in NC0.3.
 */

#include "skynet.h"
#include "skynet_server.h"
#include "atomic.h"
#include "snjs-internal.h"

#include <quickjs.h>

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

extern char **environ;

#define MODAPI __attribute__((visibility("default")))
#define RUNTIME_VERSION "0.1.0"
#define MAX_MODULE_ID 512
#define MAX_MODULE_PATH 4096

static ATOM_INT runtime_exit_code;
static ATOM_INT runtime_exit_code_set;
static struct timespec runtime_start;

__attribute__((constructor))
static void
runtime_init_start(void) {
    clock_gettime(CLOCK_MONOTONIC, &runtime_start);
}

MODAPI int
skyjs_runtime_exit_code(void) {
    if (!ATOM_LOAD(&runtime_exit_code_set)) return 0;
    return ATOM_LOAD(&runtime_exit_code);
}

static struct snjs *
getinst(JSContext *ctx) {
    return JS_GetContextOpaque(ctx);
}

static const char *
optenv(struct skynet_context *ctx, const char *key, const char *fallback) {
    const char *value = skynet_command(ctx, "GETENV", key);
    return value ? value : fallback;
}

static void
monotonic_now(struct timespec *ts) {
    if (clock_gettime(CLOCK_MONOTONIC, ts) != 0) {
        ts->tv_sec = 0;
        ts->tv_nsec = 0;
    }
}

static void
exec_path(char *buf, size_t buflen) {
#if defined(__APPLE__)
    uint32_t size = (uint32_t)buflen;
    if (_NSGetExecutablePath(buf, &size) == 0) return;
#elif defined(__linux__)
    ssize_t n = readlink("/proc/self/exe", buf, buflen - 1);
    if (n > 0) {
        buf[n] = '\0';
        return;
    }
#endif
    snprintf(buf, buflen, "skyjs");
}

static int
valid_module_path(const char *id, int allow_absolute) {
    if (id == NULL || strlen(id) >= MAX_MODULE_PATH) return 0;
    if (id[0] == '\0') return 0;
    if (id[0] == '\\') return 0;
    if (id[0] == '/' && !allow_absolute) return 0;
    const char *p = id[0] == '/' ? id + 1 : id;
    while (*p) {
        const char *slash = strchr(p, '/');
        size_t len = slash ? (size_t)(slash - p) : strlen(p);
        if (len == 0) return 0;
        if (len == 1 && p[0] == '.') return 0;
        if (len == 2 && p[0] == '.' && p[1] == '.') return 0;
        if (!slash) break;
        p = slash + 1;
    }
    return 1;
}

static int
module_source_path(struct snjs *l, const char *id, char *path, size_t path_size) {
    const char *base = id;
    const char *root = ".";
    int strip_builtin_prefix = 0;

    if (base[0] == '.' && base[1] == '\0') {
        int n = snprintf(path, path_size, ".");
        return n >= 0 && (size_t)n < path_size;
    }
    if (base[0] == '.' && base[1] == '/') base += 2;
    if (base[0] == '\0') return 0;

    if (base[0] == '/') {
        if (!valid_module_path(base, 1)) return 0;
        int n = snprintf(path, path_size, "%s", base);
        return n >= 0 && (size_t)n < path_size;
    }
    if (!valid_module_path(base, 0)) return 0;

    if (strcmp(base, "bootstrap.js") == 0 || strcmp(base, "loader.js") == 0 ||
        strncmp(base, "internal/", 9) == 0) {
        root = "./js";
    } else if (strncmp(base, "builtins/", 9) == 0) {
        root = optenv(l->ctx, "jsModuleRoot", "./js/builtins");
        strip_builtin_prefix = 1;
    }

    const char *leaf = strip_builtin_prefix ? base + 9 : base;
    size_t root_len = strlen(root);
    int needs_slash = root_len > 0 && root[root_len - 1] != '/' && leaf[0] != '\0';
    int n = snprintf(path, path_size, "%s%s%s", root,
        needs_slash ? "/" : "", leaf);
    return n >= 0 && (size_t)n < path_size;
}

static char *
read_module_file(const char *path) {
    FILE *f = fopen(path, "rb");
    if (f == NULL) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    long length = ftell(f);
    if (length < 0) {
        fclose(f);
        return NULL;
    }
    rewind(f);
    char *buf = skynet_malloc((size_t)length + 1);
    if (buf == NULL) {
        fclose(f);
        return NULL;
    }
    size_t rd = fread(buf, 1, (size_t)length, f);
    fclose(f);
    if (rd != (size_t)length) {
        skynet_free(buf);
        return NULL;
    }
    buf[rd] = '\0';
    return buf;
}

static JSValue
js_runtime_exit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct snjs *l = getinst(ctx);
    (void)this_val;
    int32_t code = 0;
    if (argc > 0 && JS_ToInt32(ctx, &code, argv[0])) return JS_EXCEPTION;
    ATOM_STORE(&runtime_exit_code, code);
    ATOM_STORE(&runtime_exit_code_set, 1);
    skynet_command(l->ctx, "ABORT", NULL);
    return JS_UNDEFINED;
}

static JSValue
js_runtime_exit_code(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    int32_t code = 0;
    if (argc > 0 && JS_ToInt32(ctx, &code, argv[0])) return JS_EXCEPTION;
    ATOM_STORE(&runtime_exit_code, code);
    ATOM_STORE(&runtime_exit_code_set, 1);
    return JS_UNDEFINED;
}

static JSValue
js_runtime_argv(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct snjs *l = getinst(ctx);
    (void)this_val; (void)argc; (void)argv;

    char path[MAX_MODULE_PATH];
    exec_path(path, sizeof(path));
    JSValue ret = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, ret, 0, JS_NewString(ctx, path));

    const char *args = l->runtime_args ? l->runtime_args : "";
    size_t args_len = strlen(args);
    char *copy = skynet_malloc(args_len + 1);
    if (copy == NULL) {
        JS_FreeValue(ctx, ret);
        return JS_EXCEPTION;
    }
    memcpy(copy, args, args_len);
    copy[args_len] = '\0';
    char *space = strchr(copy, ' ');
    if (space) *space = '\0';
    JS_SetPropertyUint32(ctx, ret, 1, JS_NewString(ctx, copy));
    if (space && space[1] != '\0') {
        JS_SetPropertyUint32(ctx, ret, 2, JS_NewString(ctx, space + 1));
    }
    skynet_free(copy);
    return ret;
}

static JSValue
js_runtime_info(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;

    struct timespec now;
    monotonic_now(&now);
    double uptime = (double)(now.tv_sec - runtime_start.tv_sec) +
        (double)(now.tv_nsec - runtime_start.tv_nsec) / 1000000000.0;
    if (uptime < 0) uptime = 0;

    char path[MAX_MODULE_PATH];
    exec_path(path, sizeof(path));

#if defined(__APPLE__)
    const char *platform = "darwin";
#elif defined(__linux__)
    const char *platform = "linux";
#else
    const char *platform = "unknown";
#endif

#if defined(__aarch64__) || defined(__arm64__)
    const char *arch = "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
    const char *arch = "x64";
#else
    const char *arch = "unknown";
#endif

    JSValue ret = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, ret, "version", JS_NewString(ctx, RUNTIME_VERSION));
    JS_SetPropertyStr(ctx, ret, "platform", JS_NewString(ctx, platform));
    JS_SetPropertyStr(ctx, ret, "arch", JS_NewString(ctx, arch));
    JS_SetPropertyStr(ctx, ret, "pid", JS_NewInt64(ctx, (int64_t)getpid()));
    JS_SetPropertyStr(ctx, ret, "ppid", JS_NewInt64(ctx, (int64_t)getppid()));
    JS_SetPropertyStr(ctx, ret, "execPath", JS_NewString(ctx, path));
    JS_SetPropertyStr(ctx, ret, "uptime", JS_NewFloat64(ctx, uptime));
    return ret;
}

static JSValue
js_runtime_hrtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;

    struct timespec now;
    monotonic_now(&now);
    JSValue ret = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, ret, 0, JS_NewInt64(ctx, (int64_t)now.tv_sec));
    JS_SetPropertyUint32(ctx, ret, 1, JS_NewInt64(ctx, (int64_t)now.tv_nsec));
    return ret;
}

static JSValue
js_runtime_environ(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;

    JSValue ret = JS_NewObject(ctx);
    for (char **entry = environ; entry != NULL && *entry != NULL; entry++) {
        const char *eq = strchr(*entry, '=');
        if (eq == NULL || eq == *entry) continue;
        size_t key_len = (size_t)(eq - *entry);
        char *key = skynet_malloc(key_len + 1);
        if (key == NULL) {
            JS_FreeValue(ctx, ret);
            return JS_EXCEPTION;
        }
        memcpy(key, *entry, key_len);
        key[key_len] = '\0';
        JS_SetPropertyStr(ctx, ret, key, JS_NewString(ctx, eq + 1));
        skynet_free(key);
    }
    return ret;
}

static JSValue
js_runtime_read_module_source(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct snjs *l = getinst(ctx);
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "skynetcore.runtime.readModuleSource(id)");
    }

    const char *id = JS_ToCString(ctx, argv[0]);
    if (id == NULL) return JS_EXCEPTION;
    char path[MAX_MODULE_PATH];
    if (!module_source_path(l, id, path, sizeof(path))) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx, "invalid module id");
    }

    const char *source = optenv(l->ctx, "jsModuleSource", "disk");
    if (strcmp(source, "disk") != 0) {
        JS_FreeCString(ctx, id);
        return JS_ThrowInternalError(ctx,
            "jsModuleSource=%s is not implemented yet", source);
    }

    char *code = read_module_file(path);
    JS_FreeCString(ctx, id);
    if (code == NULL) return JS_NULL;
    size_t code_len = strlen(code);
    JSValue ret = JS_NewStringLen(ctx, code, code_len);
    skynet_free(code);
    return ret;
}

static JSValue
js_runtime_module_realpath(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct snjs *l = getinst(ctx);
    (void)this_val;
    if (argc < 1 || !JS_IsString(argv[0])) {
        return JS_ThrowTypeError(ctx, "__snjs_realpath(path)");
    }

    const char *id = JS_ToCString(ctx, argv[0]);
    if (id == NULL) return JS_EXCEPTION;
    char path[MAX_MODULE_PATH];
    if (!module_source_path(l, id, path, sizeof(path))) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx, "invalid module path");
    }

    char resolved[PATH_MAX];
    if (realpath(path, resolved) == NULL) {
        JS_FreeCString(ctx, id);
        return JS_NULL;
    }
    JS_FreeCString(ctx, id);
    return JS_NewString(ctx, resolved);
}

void
register_runtime_module_bridge(struct snjs *l) {
    JSValue g = JS_GetGlobalObject(l->jsc);
    JS_SetPropertyStr(l->jsc, g, "__snjs_realpath",
        JS_NewCFunction(l->jsc, js_runtime_module_realpath,
            "__snjs_realpath", 1));
    JS_FreeValue(l->jsc, g);
}

void
js_runtime_set_args(struct snjs *l, const char *args, size_t sz) {
    char *copy = skynet_malloc(sz + 1);
    if (copy == NULL) return;
    if (sz > 0) memcpy(copy, args, sz);
    copy[sz] = '\0';
    skynet_free(l->runtime_args);
    l->runtime_args = copy;
}

void
register_runtime_bridge(struct snjs *l, JSValue obj) {
    JSValue runtime = JS_NewObject(l->jsc);
    JS_SetPropertyStr(l->jsc, runtime, "exit",
        JS_NewCFunction(l->jsc, js_runtime_exit, "exit", 1));
    JS_SetPropertyStr(l->jsc, runtime, "exitCode",
        JS_NewCFunction(l->jsc, js_runtime_exit_code, "exitCode", 1));
    JS_SetPropertyStr(l->jsc, runtime, "argv",
        JS_NewCFunction(l->jsc, js_runtime_argv, "argv", 0));
    JS_SetPropertyStr(l->jsc, runtime, "info",
        JS_NewCFunction(l->jsc, js_runtime_info, "info", 0));
    JS_SetPropertyStr(l->jsc, runtime, "hrtime",
        JS_NewCFunction(l->jsc, js_runtime_hrtime, "hrtime", 0));
    JS_SetPropertyStr(l->jsc, runtime, "environ",
        JS_NewCFunction(l->jsc, js_runtime_environ, "environ", 0));
    JS_SetPropertyStr(l->jsc, runtime, "readModuleSource",
        JS_NewCFunction(l->jsc, js_runtime_read_module_source, "readModuleSource", 1));
    JS_SetPropertyStr(l->jsc, obj, "runtime", runtime);
}
