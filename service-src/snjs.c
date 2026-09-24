/*
 * service_snjs.c -- QuickJS service loader for skyjs (Lua-free skynet).
 *
 * Structure mirrors service_snlua.c / service_snluajit.c:
 *   snjs_create/_init/_release/_signal + a self-sent first message that
 *   triggers init (skynet_module ABI, see 3rd/skynet/skynet-src/skynet_module.c).
 *
 * Task 2 (sync form): every message calls the JS function
 *   dispatch(msg, session, source)
 * registered on globalThis by the service script. If dispatch returns a
 * string and the message had a session, it is sent back as PTYPE_RESPONSE.
 * Errors are reported to the caller as PTYPE_ERROR.
 *
 * Isolation: this .so statically embeds quickjs-ng compiled with
 * -fvisibility=hidden; only the four snjs_* ABI symbols are exported
 * (dlopen uses RTLD_GLOBAL, see skynet_module.c _try_open).
 *
 * Memory: JS_NewRuntime2(&mf, l) routes every QuickJS allocation through
 * a header-accounted allocator, so l->mem tracks the JS heap exactly and
 * l->mem_limit enforces skynet's memlimit semantics (allocation fails ->
 * JS throws OutOfMemory). jsMemLimit config key sets the limit in bytes.
 *
 * Deadloop protection: JS_SetInterruptHandler + the "SIGNAL" command.
 * snjs_signal(0) arms the trap; the next interrupt-handler poll aborts the
 * running script with an "interrupted" error. (Unlike LuaJIT's count hook,
 * QuickJS polls the handler inside interpreted loops, so this actually
 * fires. Caveat: if the signal arrives while no JS code is running, the
 * trap stays armed and the next dispatched message is interrupted instead.)
 * The pending-job drain in worker_cb also checks the trap between jobs,
 * because a chain of tiny jobs may run enough times to starve the worker
 * without ever reaching a single in-script interrupt poll.
 */

#include "skynet.h"
#include "skynet_server.h"
#include "skynet_socket.h"
#include "atomic.h"
#include "snjs-internal.h"

#include <quickjs.h>

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MODAPI __attribute__((visibility("default")))

#ifndef SKYJS_VERSION
#define SKYJS_VERSION "0.1.0"
#endif

#define DEFAULT_MEM_REPORT (1024 * 1024 * 32)
#define JS_HDR sizeof(struct js_block)

struct js_block {
	size_t size;	// total malloc'ed size including this header
};

/* js-seri.c extensions (Task 5) */
int js_seri_init(struct snjs *l);

/* forward declaration for lazy loader (defined after read_file/optstring) */
static int eval_runtime(struct snjs *l, const char *path, const char *where);

/* ------------------------------------------------------------------ allocator */

static void
mem_report_check(struct snjs *l) {
	if (l->mem > l->mem_report) {
		l->mem_report *= 2;
		skynet_error(l->ctx, "JS memory warning %.2f M", (float)l->mem / (1024 * 1024));
	}
}

static void *
js_allocf(void *ud, size_t size) {
	struct snjs *l = ud;
	if (size == 0) {
		size = 1;
	}
	size_t total = size + JS_HDR;
	if (l->mem_limit != 0 && l->mem + total > l->mem_limit) {
		return NULL;
	}
	struct js_block *b = skynet_malloc(total);
	if (b == NULL) {
		return NULL;
	}
	b->size = total;
	l->mem += total;
	mem_report_check(l);
	return b + 1;
}

static void
js_releasef(void *ud, void *ptr) {
	struct snjs *l = ud;
	if (ptr == NULL) {
		return;
	}
	struct js_block *b = (struct js_block *)ptr - 1;
	l->mem -= b->size;
	skynet_free(b);
}

static void *
js_callocf(void *ud, size_t count, size_t size) {
	if (size != 0 && count > (size_t)-1 / size) {
		return NULL;
	}
	size_t total = count * size;
	void *p = js_allocf(ud, total);
	if (p) {
		memset(p, 0, total);
	}
	return p;
}

static void *
js_mallocf(void *ud, size_t size) {
	return js_allocf(ud, size);
}

static void
js_freef(void *ud, void *ptr) {
	js_releasef(ud, ptr);
}

static void *
js_reallocf(void *ud, void *ptr, size_t size) {
	struct snjs *l = ud;
	if (ptr == NULL) {
		return js_allocf(ud, size);
	}
	if (size == 0) {
		js_releasef(ud, ptr);
		return NULL;
	}
	struct js_block *b = (struct js_block *)ptr - 1;
	size_t total = size + JS_HDR;
	if (l->mem_limit != 0 && total > b->size && l->mem + (total - b->size) > l->mem_limit) {
		return NULL;	// original block stays valid, QuickJS throws OOM
	}
	struct js_block *nb = skynet_realloc(b, total);
	if (nb == NULL) {
		return NULL;
	}
	l->mem += total - nb->size;
	nb->size = total;
	mem_report_check(l);
	return nb + 1;
}

static size_t
js_usablef(const void *ptr) {
	if (ptr == NULL) {
		return 0;
	}
	const struct js_block *b = (const struct js_block *)ptr - 1;
	return b->size - JS_HDR;
}

static const JSMallocFunctions js_mf = {
	js_callocf,
	js_mallocf,
	js_freef,
	js_reallocf,
	js_usablef,
};

/* ------------------------------------------------------------------ helpers */

static void
dump_exception(struct snjs *l, const char *where) {
	JSValue exc = JS_GetException(l->jsc);
	if (JS_IsNull(exc)) {
		skynet_error(l->ctx, "%s: unknown exception", where);
		return;
	}
	size_t len = 0;
	const char *s = JS_ToCStringLen(l->jsc, &len, exc);
	skynet_error(l->ctx, "%s: %s", where, s ? s : "(no message)");
	if (s) {
		JS_FreeCString(l->jsc, s);
	}
	JSValue stack = JS_GetPropertyStr(l->jsc, exc, "stack");
	if (JS_IsString(stack)) {
		s = JS_ToCStringLen(l->jsc, &len, stack);
		if (s) {
			skynet_error(l->ctx, "%s", s);
			JS_FreeCString(l->jsc, s);
		}
	}
	JS_FreeValue(l->jsc, stack);
	JS_FreeValue(l->jsc, exc);
}

// int_command: skynet_command results are ":hex" (REG/QUERY/LAUNCH) or decimal
// (TIMEOUT); mirror the lua intcommand behavior of skipping the leading ':'.
static int
intcmd(struct skynet_context *ctx, const char *cmd, const char *parm) {
	const char * r = skynet_command(ctx, cmd, parm);
	if (r == NULL) {
		return 0;
	}
	if (r[0] == ':') {
		return (int)strtoul(r + 1, NULL, 16);
	}
	return atoi(r);
}

static int
interrupt_handler(JSRuntime *rt, void *ud) {
	struct snjs *l = ud;
	(void)rt;
	if (ATOM_LOAD(&l->trap)) {
		ATOM_STORE(&l->trap, 0);
		// returning non-zero makes QuickJS throw "interrupted"
		return 1;
	}
	return 0;
}

/* ------------------------------------------------------------------ bridge */

static struct snjs *
getinst(JSContext *ctx) {
	return JS_GetContextOpaque(ctx);
}

static JSValue
js_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	if (argc < 3) {
		return JS_ThrowTypeError(ctx, "skynetcore.send(dest, type, msg, session=0)");
	}
	int32_t dest, type, session = 0;
	if (JS_ToInt32(ctx, &dest, argv[0])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &type, argv[1])) return JS_EXCEPTION;
	if (argc > 3 && JS_ToInt32(ctx, &session, argv[3])) return JS_EXCEPTION;
	void *buf = NULL;
	size_t sz = 0;
	if (JS_IsArrayBuffer(argv[2])) {
		// binary payloads (lua-seri) cross as ArrayBuffer
		uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[2]);
		if (p == NULL) return JS_EXCEPTION;
		buf = skynet_malloc(sz);
		memcpy(buf, p, sz);
	} else if (!JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
		size_t msz = 0;
		const char *msg = JS_ToCStringLen(ctx, &msz, argv[2]);
		if (msg == NULL) return JS_EXCEPTION;
		sz = msz;
		if (sz > 0) {
			buf = skynet_malloc(sz);
			memcpy(buf, msg, sz);
		}
		JS_FreeCString(ctx, msg);
	}
	// `buf` is a fresh skynet_malloc block: hand its ownership to the kernel
	// via PTYPE_TAG_DONTCOPY (same contract as lsend's lightuserdata path).
	// Without the tag skynet_send copies the payload and the caller keeps
	// ownership of `buf` -- omitting the free here used to leak the full
	// message size on every JS-originated send.
	int r = skynet_send(l->ctx, 0, (uint32_t)dest, type | PTYPE_TAG_DONTCOPY, session, buf, sz);
	return JS_NewInt32(ctx, r);
}

static JSValue
js_command(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *cmd = JS_ToCString(ctx, argv[0]);
	if (cmd == NULL) return JS_EXCEPTION;
	const char *parm = NULL;
	if (argc > 1 && JS_IsString(argv[1])) {
		parm = JS_ToCString(ctx, argv[1]);
	}
	const char * r = skynet_command(l->ctx, cmd, parm);
	JSValue ret = r ? JS_NewString(ctx, r) : JS_NULL;
	JS_FreeCString(ctx, cmd);
	JS_FreeCString(ctx, parm);
	return ret;
}

static JSValue
js_intcommand(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *cmd = JS_ToCString(ctx, argv[0]);
	if (cmd == NULL) return JS_EXCEPTION;
	const char *parm = NULL;
	if (argc > 1 && JS_IsString(argv[1])) {
		parm = JS_ToCString(ctx, argv[1]);
	}
	int r = intcmd(l->ctx, cmd, parm);
	JS_FreeCString(ctx, cmd);
	JS_FreeCString(ctx, parm);
	return JS_NewInt32(ctx, r);
}

static JSValue
js_genid(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc; (void)argv;
	return JS_NewInt32(ctx, skynet_context_newsession(l->ctx));
}

static JSValue
js_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc; (void)argv;
	return JS_NewInt64(ctx, (int64_t)skynet_now());
}

static JSValue
js_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *msg = JS_ToCString(ctx, argv[0]);
	if (msg == NULL) return JS_EXCEPTION;
	skynet_error(l->ctx, "%s", msg);
	JS_FreeCString(ctx, msg);
	return JS_UNDEFINED;
}

static JSValue
js_mem(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc; (void)argv;
	return JS_NewFloat64(ctx, (double)l->mem);
}

// response(session, source, msg): reply to a caller from JS (used by __snjs_wrap
// and skynet.call internals). The message is copied; DONTCOPY semantics.
// msg may be a string or an ArrayBuffer (lua-seri payloads).
static JSValue
js_response(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	int32_t session;
	uint32_t source;
	if (JS_ToInt32(ctx, &session, argv[0])) return JS_EXCEPTION;
	if (JS_ToUint32(ctx, &source, argv[1])) return JS_EXCEPTION;
	void *buf = NULL;
	size_t sz = 0;
	if (JS_IsArrayBuffer(argv[2])) {
		uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[2]);
		if (p == NULL) return JS_EXCEPTION;
		buf = skynet_malloc(sz);
		memcpy(buf, p, sz);
	} else if (!JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) {
		const char *msg = JS_ToCStringLen(ctx, &sz, argv[2]);
		if (msg == NULL) return JS_EXCEPTION;
		if (sz > 0) {
			buf = skynet_malloc(sz);
			memcpy(buf, msg, sz);
		}
		JS_FreeCString(ctx, msg);
	}
	skynet_send(l->ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, buf, sz);
	return JS_UNDEFINED;
}

// error_response(session, source): reject a pending call with PTYPE_ERROR
static JSValue
js_error_response(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	int32_t session;
	uint32_t source;
	if (JS_ToInt32(ctx, &session, argv[0])) return JS_EXCEPTION;
	if (JS_ToUint32(ctx, &source, argv[1])) return JS_EXCEPTION;
	skynet_send(l->ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
	return JS_UNDEFINED;
}

// redirect(dest, source, type, session, msg): forward a message with a
// spoofed source (skynet.redirect). Ownership of the fresh skynet_malloc
// buffer transfers to the kernel via PTYPE_TAG_DONTCOPY, same contract as
// js_send. msg may be a string or an ArrayBuffer (raw client frames).
static JSValue
js_redirect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	if (argc < 5) {
		return JS_ThrowTypeError(ctx, "skynetcore.redirect(dest, source, type, session, msg)");
	}
	int32_t dest, type, session;
	uint32_t source;
	if (JS_ToInt32(ctx, &dest, argv[0])) return JS_EXCEPTION;
	if (JS_ToUint32(ctx, &source, argv[1])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &type, argv[2])) return JS_EXCEPTION;
	if (JS_ToInt32(ctx, &session, argv[3])) return JS_EXCEPTION;
	void *buf = NULL;
	size_t sz = 0;
	if (JS_IsArrayBuffer(argv[4])) {
		uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[4]);
		if (p == NULL) return JS_EXCEPTION;
		if (sz > 0) {
			buf = skynet_malloc(sz);
			memcpy(buf, p, sz);
		}
	} else if (!JS_IsUndefined(argv[4]) && !JS_IsNull(argv[4])) {
		const char *msg = JS_ToCStringLen(ctx, &sz, argv[4]);
		if (msg == NULL) return JS_EXCEPTION;
		if (sz > 0) {
			buf = skynet_malloc(sz);
			memcpy(buf, msg, sz);
		}
		JS_FreeCString(ctx, msg);
	}
	int r = skynet_send(l->ctx, source, (uint32_t)dest, type | PTYPE_TAG_DONTCOPY, session, buf, sz);
	return JS_NewInt32(ctx, r);
}

static const char lazy_setup_js[] =
"(function() {\n"
"    const P = globalThis.__snjs_lazy_paths;\n"
"    delete globalThis.__snjs_lazy_paths;\n"
"    const F = {};\n"
"    F[P.socket]       = { g: ['socket'], d: [] };\n"
"    F[P.crypt]        = { g: ['crypt'], d: [] };\n"
"    F[P.sockethelper] = { g: ['sockethelper'], d: [P.socket] };\n"
"    F[P.cluster]      = { g: ['cluster'], d: [] };\n"
"    F[P.gateserver]   = { g: ['gateserver'], d: [] };\n"
"    F[P.http]         = { g: ['httpd', 'httpc', 'httpInternal'], d: [P.sockethelper] };\n"
"    F[P.websocket]    = { g: ['websocket'], d: [P.http, P.crypt, P.sockethelper] };\n"
"    F[P.io]           = { g: ['io'], d: [] };\n"
"    F[P.ioservice]    = { g: [], d: [P.io, P.crypt] };\n"
"    const L = {};\n"
"    function load(p) {\n"
"        if (L[p]) return;\n"
"        const m = F[p];\n"
"        if (!m) return;\n"
"        m.d.forEach(load);\n"
"        m.g.forEach(function(n) { delete globalThis[n]; });\n"
"        skynetcore.__load_runtime(p);\n"
"        L[p] = true;\n"
"    }\n"
"    const keys = Object.keys(F);\n"
"    for (let i = 0; i < keys.length; i++) {\n"
"        const p = keys[i];\n"
"        const names = F[p].g;\n"
"        for (let j = 0; j < names.length; j++) {\n"
"            (function(path, name) {\n"
"                Object.defineProperty(globalThis, name, {\n"
"                    get: function() { load(path); return globalThis[name]; },\n"
"                    configurable: true,\n"
"                    enumerable: true\n"
"                });\n"
"            })(p, names[j]);\n"
"        }\n"
"    }\n"
"})();\n";

static JSValue
js_load_runtime(JSContext *ctx, JSValueConst this_val,
                int argc, JSValueConst *argv)
{
	struct snjs *l = JS_GetContextOpaque(ctx);
	const char *path = JS_ToCString(ctx, argv[0]);
	if (!path) return JS_EXCEPTION;
	int r = eval_runtime(l, path, "lazy module load error");
	JS_FreeCString(ctx, path);
	if (r < 0)
		return JS_ThrowInternalError(ctx, "failed to load runtime module");
	return JS_UNDEFINED;
}

static JSValue
js_feature(JSContext *ctx, int available, const char *reason, const char *version) {
	JSValue feature = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, feature, "available", JS_NewBool(ctx, available));
	if (reason != NULL) {
		JS_SetPropertyStr(ctx, feature, "reason", JS_NewString(ctx, reason));
	}
	if (version != NULL) {
		JS_SetPropertyStr(ctx, feature, "version", JS_NewString(ctx, version));
	}
	return feature;
}

static JSValue
js_features(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc; (void)argv;

	JSValue features = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, features, "version", JS_NewString(ctx, SKYJS_VERSION));
	JS_SetPropertyStr(ctx, features, "sqlite",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	JS_SetPropertyStr(ctx, features, "httpStream",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	JS_SetPropertyStr(ctx, features, "fsAsync",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	JS_SetPropertyStr(ctx, features, "archive",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	JS_SetPropertyStr(ctx, features, "subprocess",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	JS_SetPropertyStr(ctx, features, "media",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	JS_SetPropertyStr(ctx, features, "tag",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
#ifdef USE_OPENSSL
	JS_SetPropertyStr(ctx, features, "cryptExt",
		js_feature(ctx, 1, NULL, NULL));
#else
	JS_SetPropertyStr(ctx, features, "cryptExt",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
#endif
	JSValue native_ext = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, native_ext, "available", JS_NewBool(ctx, 0));
	JS_SetPropertyStr(ctx, native_ext, "reason",
		JS_NewString(ctx, "ERR_UNSUPPORTED_PLATFORM"));
	JS_SetPropertyStr(ctx, native_ext, "dynamic", JS_NewBool(ctx, 0));
	JS_SetPropertyStr(ctx, native_ext, "static", JS_NewBool(ctx, 0));
	JS_SetPropertyStr(ctx, features, "nativeExt", native_ext);
	JS_SetPropertyStr(ctx, features, "pluginSandbox",
		js_feature(ctx, 0, "ERR_UNSUPPORTED_PLATFORM", NULL));
	return features;
}

static void
register_bridge(struct snjs *l) {
	JSValue obj = JS_NewObject(l->jsc);
	JS_SetPropertyStr(l->jsc, obj, "send", JS_NewCFunction(l->jsc, js_send, "send", 4));
	JS_SetPropertyStr(l->jsc, obj, "command", JS_NewCFunction(l->jsc, js_command, "command", 2));
	JS_SetPropertyStr(l->jsc, obj, "intCommand", JS_NewCFunction(l->jsc, js_intcommand, "intCommand", 2));
	JS_SetPropertyStr(l->jsc, obj, "genId", JS_NewCFunction(l->jsc, js_genid, "genId", 0));
	JS_SetPropertyStr(l->jsc, obj, "now", JS_NewCFunction(l->jsc, js_now, "now", 0));
	JS_SetPropertyStr(l->jsc, obj, "error", JS_NewCFunction(l->jsc, js_error, "error", 1));
	JS_SetPropertyStr(l->jsc, obj, "mem", JS_NewCFunction(l->jsc, js_mem, "mem", 0));
	JS_SetPropertyStr(l->jsc, obj, "response", JS_NewCFunction(l->jsc, js_response, "response", 3));
	JS_SetPropertyStr(l->jsc, obj, "errorResponse", JS_NewCFunction(l->jsc, js_error_response, "errorResponse", 2));
	JS_SetPropertyStr(l->jsc, obj, "redirect", JS_NewCFunction(l->jsc, js_redirect, "redirect", 5));
	JS_SetPropertyStr(l->jsc, obj, "features",
		JS_NewCFunction(l->jsc, js_features, "features", 0));

	register_net_bridge(l->jsc, obj);
	// js-runtime primitives (process/module-source foundation)
	register_runtime_bridge(l, obj);

	// js-seri extensions (pack/unpack, see js-seri.c)
	register_seri_bridge(l->jsc, obj);
	JS_SetPropertyStr(l->jsc, obj, "__load_runtime",
		JS_NewCFunction(l->jsc, js_load_runtime, "__load_runtime", 1));
	JSValue g = JS_GetGlobalObject(l->jsc);
	JS_SetPropertyStr(l->jsc, g, "skynetcore", obj);
	register_crypto_bridge(l->jsc, g);
#ifdef USE_OPENSSL
	register_tls_bridge(l->jsc, g);
#endif
	register_io_bridge(l->jsc, g);
	register_runtime_module_bridge(l);
	JS_FreeValue(l->jsc, g);
}

/* ------------------------------------------------------------------ worker */

static int
worker_cb(struct skynet_context *ctx, void *ud, int type, int session, uint32_t source, const void *msg, size_t sz) {
	struct snjs *l = ud;
	JSValue payload;
	// the runtime may have been created on another worker thread (a nested
	// LAUNCH during a foreign dispatch): re-anchor stack_top so QuickJS's
	// stack-overflow check is measured against THIS thread's stack
	JS_UpdateStackTop(l->rt);
	if (ATOM_LOAD(&l->trap)) {
		ATOM_STORE(&l->trap, 0);
		skynet_error(l->ctx, "snjs: stale SIGNAL trap cleared");
	}
	if (type == PTYPE_SOCKET) {
		// skynet_socket_message: {type, id, ud, buffer}; for DATA/UDP buffer is a
		// fresh skynet_malloc block OWNED by this service (forward_message_tcp
		// MALLOCs it; skynet_server only frees the sm struct, never sm->buffer),
		// so we must skynet_free it after copying -- same ownership contract as
		// lua socket.lua's driver.push. Control events (padding=true) carry text
		// at sm+1 inside the sm allocation and have buffer == NULL.
		struct skynet_socket_message *sm = (struct skynet_socket_message *)msg;
		if (l->socket_netpack) {
			// gateserver mode: DATA is reassembled by the C frame buffer,
			// which takes over sm->buffer (freed in js_netpack_dispatch).
			JSValue ev;
			if (!js_netpack_dispatch(l, sm, sz, &ev)) {
				return 0;   // uncomplete packet buffered, nothing to deliver
			}
			payload = ev;
		} else {
			payload = JS_NewObject(l->jsc);
			JS_SetPropertyStr(l->jsc, payload, "type", JS_NewInt32(l->jsc, sm->type));
			JS_SetPropertyStr(l->jsc, payload, "id", JS_NewInt32(l->jsc, sm->id));
			JS_SetPropertyStr(l->jsc, payload, "ud", JS_NewInt32(l->jsc, sm->ud));
			if (sm->buffer != NULL) {
				// DATA/UDP payload is binary-safe: deliver as ArrayBuffer, so
				// socket.js can decode text only for text-mode connections
				// (per-connection binary). Ownership contract unchanged.
				JS_SetPropertyStr(l->jsc, payload, "data", JS_NewArrayBufferCopy(l->jsc, (const uint8_t *)sm->buffer, sm->ud));
				skynet_free(sm->buffer);
				sm->buffer = NULL;
			} else if (sz > sizeof(*sm)) {
				JS_SetPropertyStr(l->jsc, payload, "data", JS_NewString(l->jsc, (const char *)(sm + 1)));
			} else {
				JS_SetPropertyStr(l->jsc, payload, "data", JS_NULL);
			}
		}
	} else if (type == PTYPE_RESERVED_LUA || type == PTYPE_RESPONSE || type == PTYPE_CLIENT) {
		// binary-safe: lua payloads, responses, and client (gate) frames cross
		// as ArrayBuffer; skynet.js decodes text responses per call protocol
		payload = JS_NewArrayBufferCopy(l->jsc, msg ? (const uint8_t *)msg : (const uint8_t *)"", sz);
	} else {
		payload = JS_NewStringLen(l->jsc, msg ? (const char *)msg : "", sz);
	}
	JSValueConst argv[4] = {
		payload,
		JS_NewInt32(l->jsc, session),
		JS_NewUint32(l->jsc, source),
		JS_NewInt32(l->jsc, type),
	};
	if (JS_IsException(argv[0])) {
		dump_exception(l, "snjs: can't build message");
		return 0;
	}
	JSValue ret = JS_Call(l->jsc, l->dispatch, JS_UNDEFINED, 4, argv);
	JS_FreeValue(l->jsc, argv[0]);
	if (JS_IsException(ret)) {
		dump_exception(l, "snjs dispatch error");
		if (session != 0) {
			skynet_send(ctx, 0, source, PTYPE_ERROR, session, NULL, 0);
		}
	} else if (!l->js_managed && session != 0) {
		// legacy sync form (no skynet.js loader): string result -> response
		size_t rsz = 0;
		const char *r = JS_ToCStringLen(l->jsc, &rsz, ret);
		if (r != NULL && rsz > 0) {
			char *buf = skynet_malloc(rsz);
			memcpy(buf, r, rsz);
			skynet_send(ctx, 0, source, PTYPE_RESPONSE | PTYPE_TAG_DONTCOPY, session, buf, rsz);
			JS_FreeCString(l->jsc, r);
		}
	}
	JS_FreeValue(l->jsc, ret);
	// Drive pending microtasks. Tiny jobs may not execute enough bytecode for
	// QuickJS's interrupt poll, so also observe SIGNAL between jobs. The queued
	// chain cannot be unwound safely at that boundary; retire the service rather
	// than leave jobs that could resume during a later message.
	JSContext *c1;
	int job_status = 0;
	for (;;) {
		if (ATOM_LOAD(&l->trap)) {
			ATOM_STORE(&l->trap, 0);
			skynet_error(l->ctx, "snjs pending job loop interrupted");
			skynet_command(ctx, "EXIT", NULL);
			break;
		}
		job_status = JS_ExecutePendingJob(l->rt, &c1);
		if (job_status <= 0) break;
	}
	if (job_status < 0) {
		dump_exception(l, "snjs pending job error");
	}
	return 0;
}

/* ------------------------------------------------------------------ launch */

static char *
read_file(const char *path) {
	FILE * f = fopen(path, "rb");
	if (f == NULL) {
		return NULL;
	}
	fseek(f, 0, SEEK_END);
	long sz = ftell(f);
	fseek(f, 0, SEEK_SET);
	if (sz < 0) {
		fclose(f);
		return NULL;
	}
	char * buf = skynet_malloc(sz + 1);
	size_t rd = fread(buf, 1, sz, f);
	fclose(f);
	buf[rd] = '\0';
	return buf;
}

static const char *
optstring(struct skynet_context *ctx, const char *key, const char * str) {
	const char * ret = skynet_command(ctx, "GETENV", key);
	return ret ? ret : str;
}

/*
 * Embedded bytecode of the default runtime libraries (generated by the
 * Makefile via qjsc from js/skynet.js, js/socket.js, js/crypt.js,
 * js/cluster.js, js/gateserver.js, js/http.js and js/websocket.js;
 * see build/rt_bc.c).
 * Loading bytecode skips the per-service parse cost and the retained
 * source text. A non-default jsLoader/jsSocket/jsCrypt/jsSockethelper/
 * jsCluster/jsGateserver/jsHttp/jsWebsocket env value falls back to
 * source eval,
 * as does an unreadable bytecode blob (submodule/version skew) --
 * behaviour stays identical either way.
 */
extern const uint8_t snjs_bc_skynet[];
extern const uint32_t snjs_bc_skynet_size;
extern const uint8_t snjs_bc_socket[];
extern const uint32_t snjs_bc_socket_size;
extern const uint8_t snjs_bc_crypt[];
extern const uint32_t snjs_bc_crypt_size;
extern const uint8_t snjs_bc_sockethelper[];
extern const uint32_t snjs_bc_sockethelper_size;
extern const uint8_t snjs_bc_cluster[];
extern const uint32_t snjs_bc_cluster_size;
extern const uint8_t snjs_bc_gateserver[];
extern const uint32_t snjs_bc_gateserver_size;
extern const uint8_t snjs_bc_http[];
extern const uint32_t snjs_bc_http_size;
extern const uint8_t snjs_bc_websocket[];
extern const uint32_t snjs_bc_websocket_size;
extern const uint8_t snjs_bc_io[];
extern const uint32_t snjs_bc_io_size;
extern const uint8_t snjs_bc_ioservice[];
extern const uint32_t snjs_bc_ioservice_size;

static const uint8_t *
embedded_runtime_bc(const char *path, size_t *len) {
	if (strcmp(path, "./js/skynet.js") == 0) {
		*len = snjs_bc_skynet_size;
		return snjs_bc_skynet;
	}
	if (strcmp(path, "./js/socket.js") == 0) {
		*len = snjs_bc_socket_size;
		return snjs_bc_socket;
	}
	if (strcmp(path, "./js/crypt.js") == 0) {
		*len = snjs_bc_crypt_size;
		return snjs_bc_crypt;
	}
	if (strcmp(path, "./js/sockethelper.js") == 0) {
		*len = snjs_bc_sockethelper_size;
		return snjs_bc_sockethelper;
	}
	if (strcmp(path, "./js/cluster.js") == 0) {
		*len = snjs_bc_cluster_size;
		return snjs_bc_cluster;
	}
	if (strcmp(path, "./js/gateserver.js") == 0) {
		*len = snjs_bc_gateserver_size;
		return snjs_bc_gateserver;
	}
	if (strcmp(path, "./js/http.js") == 0) {
		*len = snjs_bc_http_size;
		return snjs_bc_http;
	}
	if (strcmp(path, "./js/websocket.js") == 0) {
		*len = snjs_bc_websocket_size;
		return snjs_bc_websocket;
	}
	if (strcmp(path, "./js/io.js") == 0) {
		*len = snjs_bc_io_size;
		return snjs_bc_io;
	}
	if (strcmp(path, "./js/ioservice.js") == 0) {
		*len = snjs_bc_ioservice_size;
		return snjs_bc_ioservice;
	}
	return NULL;
}

/*
 * Evaluate one runtime library. Returns 1 when it was loaded, 0 when the
 * file was absent (optional loader skipped, matching the original
 * read_file behaviour) and -1 on a fatal evaluation error (exception
 * already dumped).
 */
static int
eval_runtime(struct snjs *l, const char *path, const char *where) {
	size_t blen = 0;
	const uint8_t *bc = embedded_runtime_bc(path, &blen);
	if (bc != NULL) {
		JSValue fun = JS_ReadObject(l->jsc, bc, blen, JS_READ_OBJ_BYTECODE);
		if (!JS_IsException(fun)) {
			JSValue ret = JS_EvalFunction(l->jsc, fun);   // consumes fun
			if (!JS_IsException(ret)) {
				JS_FreeValue(l->jsc, ret);
				return 1;
			}
			dump_exception(l, where);
			return -1;   // bytecode parsed but errored: a real failure
		}
		// version skew or corruption: discard and fall back to source
		JS_FreeValue(l->jsc, JS_GetException(l->jsc));
	}
	char *code = read_file(path);
	if (code == NULL) {
		return 0;   // optional loader absent
	}
	JSValue ret = JS_Eval(l->jsc, code, strlen(code), path, JS_EVAL_TYPE_GLOBAL);
	skynet_free(code);
	if (JS_IsException(ret)) {
		dump_exception(l, where);
		return -1;
	}
	JS_FreeValue(l->jsc, ret);
	return 1;
}

static int
init_cb(struct snjs *l, struct skynet_context *ctx, const char * args, size_t sz) {
	l->ctx = ctx;
	js_runtime_set_args(l, args, sz);
	// see worker_cb: init may run on a worker whose stack differs from the
	// thread that called JS_NewRuntime2 (the nested-LAUNCH case)
	JS_UpdateStackTop(l->rt);

	const char *limit = optstring(ctx, "jsMemLimit", NULL);
	if (limit) {
		l->mem_limit = (size_t)strtoull(limit, NULL, 10);
		if (l->mem_limit > 0) {
			JS_SetMemoryLimit(l->rt, l->mem_limit);
			skynet_error(ctx, "JS memlimit set to %.2f M", (float)l->mem_limit / (1024 * 1024));
		}
	}

	JS_SetInterruptHandler(l->rt, interrupt_handler, l);
	register_bridge(l);
	if (js_seri_init(l)) {
		dump_exception(l, "snjs seri init error");
		return 1;
	}

	// Preload the JS runtime core (skynet.js) unless overridden or absent.
	// Its presence switches the service to managed mode: responses are sent
	// from JS via __snjs_wrap, enabling async dispatch.
	const char *loader = optstring(ctx, "jsLoader", "./js/skynet.js");
	int lr = eval_runtime(l, loader, "snjs loader error");
	if (lr < 0) return 1;
	if (lr > 0) l->js_managed = 1;

	{
		JSValue g = JS_GetGlobalObject(l->jsc);
		JSValue paths = JS_NewObject(l->jsc);
		JS_SetPropertyStr(l->jsc, paths, "socket",
			JS_NewString(l->jsc, optstring(ctx, "jsSocket", "./js/socket.js")));
		JS_SetPropertyStr(l->jsc, paths, "crypt",
			JS_NewString(l->jsc, optstring(ctx, "jsCrypt", "./js/crypt.js")));
		JS_SetPropertyStr(l->jsc, paths, "sockethelper",
			JS_NewString(l->jsc, optstring(ctx, "jsSockethelper", "./js/sockethelper.js")));
		JS_SetPropertyStr(l->jsc, paths, "cluster",
			JS_NewString(l->jsc, optstring(ctx, "jsCluster", "./js/cluster.js")));
		JS_SetPropertyStr(l->jsc, paths, "gateserver",
			JS_NewString(l->jsc, optstring(ctx, "jsGateserver", "./js/gateserver.js")));
		JS_SetPropertyStr(l->jsc, paths, "http",
			JS_NewString(l->jsc, optstring(ctx, "jsHttp", "./js/http.js")));
		JS_SetPropertyStr(l->jsc, paths, "websocket",
			JS_NewString(l->jsc, optstring(ctx, "jsWebsocket", "./js/websocket.js")));
		JS_SetPropertyStr(l->jsc, paths, "io",
			JS_NewString(l->jsc, optstring(ctx, "jsIo", "./js/io.js")));
		JS_SetPropertyStr(l->jsc, paths, "ioservice",
			JS_NewString(l->jsc, optstring(ctx, "jsIoservice", "./js/ioservice.js")));
		JS_SetPropertyStr(l->jsc, g, "__snjs_lazy_paths", paths);
		JS_FreeValue(l->jsc, g);
		JSValue lret = JS_Eval(l->jsc, lazy_setup_js, strlen(lazy_setup_js),
			"<lazy>", JS_EVAL_TYPE_GLOBAL);
		if (JS_IsException(lret)) {
			dump_exception(l, "snjs lazy setup error");
			return 1;
		}
		JS_FreeValue(l->jsc, lret);
	}

	JS_RunGC(l->rt);

	// args: "<script path> [param]"
	char *tmp = skynet_malloc(sz + 1);
	memcpy(tmp, args, sz);
	tmp[sz] = '\0';
	char *sp = strchr(tmp, ' ');
	const char *param = "";
	if (sp) {
		*sp = '\0';
		param = sp + 1;
	}

	// NC0.2 bootstrap: loader.js is evaluated as a plain script, then it
	// requires bootstrap.js and the service entry. The legacy lazy globals
	// above remain in place until NC0.8; existing service scripts simply run
	// inside the new CJS wrapper without being migrated.
	{
		JSValue g = JS_GetGlobalObject(l->jsc);
		JS_SetPropertyStr(l->jsc, g, "__snjs_bootstrap",
			JS_NewString(l->jsc, optstring(ctx, "jsBootstrap", "./js/bootstrap.js")));
		JS_SetPropertyStr(l->jsc, g, "__snjs_main", JS_NewString(l->jsc, tmp));
		JS_SetPropertyStr(l->jsc, g, "__snjs_param", JS_NewString(l->jsc, param));
		JS_FreeValue(l->jsc, g);
	}

	char *loader_code = read_file("./js/loader.js");
	if (loader_code == NULL) {
		skynet_error(ctx, "snjs can't open module loader js/loader.js");
		skynet_free(tmp);
		return 1;
	}
	JSValue ret = JS_Eval(l->jsc, loader_code, strlen(loader_code),
		"./js/loader.js", JS_EVAL_TYPE_GLOBAL);
	skynet_free(loader_code);
	if (JS_IsException(ret)) {
		dump_exception(l, "snjs loader error");
		skynet_free(tmp);
		return 1;
	}
	JS_FreeValue(l->jsc, ret);
	JSValue g = JS_GetGlobalObject(l->jsc);
	JSValue dispatch = JS_GetPropertyStr(l->jsc, g, "dispatch");
	if (!JS_IsFunction(l->jsc, dispatch)) {
		skynet_error(ctx, "snjs script %s must define globalThis.dispatch", tmp);
		JS_FreeValue(l->jsc, dispatch);
		JS_FreeValue(l->jsc, g);
		skynet_free(tmp);
		return 1;
	}
	l->dispatch = JS_DupValue(l->jsc, dispatch);
	if (l->js_managed) {
		// wrap the user-visible dispatch: owns response/error sending and
		// turns Promise results into replies after the pending jobs drain.
		JSValue wrap = JS_GetPropertyStr(l->jsc, g, "__snjs_wrap");
		if (JS_IsFunction(l->jsc, wrap)) {
			JSValueConst warg[1] = { dispatch };
			JSValue wrapped = JS_Call(l->jsc, wrap, JS_UNDEFINED, 1, warg);
			if (JS_IsException(wrapped)) {
				dump_exception(l, "snjs wrap error");
				skynet_free(tmp);
				return 1;
			}
			JS_FreeValue(l->jsc, l->dispatch);
			l->dispatch = JS_DupValue(l->jsc, wrapped);
			JS_FreeValue(l->jsc, wrapped);
		}
		JS_FreeValue(l->jsc, wrap);
	}
	JS_FreeValue(l->jsc, dispatch);
	JS_FreeValue(l->jsc, g);
	skynet_free(tmp);

	skynet_callback(ctx, l, worker_cb);
	return 0;
}

static int
launch_cb(struct skynet_context *ctx, void *ud, int type, int session, uint32_t source, const void *msg, size_t sz) {
	assert(type == 0 && session == 0);
	struct snjs *l = ud;
	skynet_callback(ctx, NULL, NULL);
	if (init_cb(l, ctx, msg ? (const char *)msg : "", sz)) {
		skynet_command(ctx, "EXIT", NULL);
	}
	return 0;
}

MODAPI int
snjs_init(struct snjs *l, struct skynet_context *ctx, const char * args) {
	int sz = strlen(args);
	char * tmp = skynet_malloc(sz);
	memcpy(tmp, args, sz);
	skynet_callback(ctx, l, launch_cb);
	const char * self = skynet_command(ctx, "REG", NULL);
	uint32_t handle_id = strtoul(self + 1, NULL, 16);
	skynet_send(ctx, 0, handle_id, PTYPE_TAG_DONTCOPY, 0, tmp, sz);
	return 0;
}

/* ------------------------------------------------------------------ ABI */

MODAPI struct snjs *
snjs_create(void) {
	struct snjs * l = skynet_malloc(sizeof(*l));
	memset(l, 0, sizeof(*l));
	l->mem_report = DEFAULT_MEM_REPORT;
	l->mem_limit = 0;
	l->dispatch = JS_UNDEFINED;
	l->map_entries_fn = JS_UNDEFINED;
	l->lua_table_build_fn = JS_UNDEFINED;
	l->lua_table_parts_fn = JS_UNDEFINED;
	ATOM_INIT(&l->trap, 0);
	l->rt = JS_NewRuntime2(&js_mf, l);
	if (l->rt == NULL) {
		skynet_free(l);
		return NULL;
	}
	l->jsc = JS_NewContextRaw(l->rt);
	if (l->jsc == NULL) {
		JS_FreeRuntime(l->rt);
		skynet_free(l);
		return NULL;
	}
	JS_AddIntrinsicBaseObjects(l->jsc);
	JS_AddIntrinsicDate(l->jsc);
	JS_AddIntrinsicEval(l->jsc);
	JS_AddIntrinsicRegExpCompiler(l->jsc);
	JS_AddIntrinsicRegExp(l->jsc);
	JS_AddIntrinsicJSON(l->jsc);
	JS_AddIntrinsicMapSet(l->jsc);
	JS_AddIntrinsicTypedArrays(l->jsc);
	JS_AddIntrinsicPromise(l->jsc);
	JS_AddIntrinsicBigInt(l->jsc);
	JS_SetContextOpaque(l->jsc, l);
	return l;
}

MODAPI void
snjs_release(struct snjs *l) {
	js_netpack_free(l);
	skynet_free(l->runtime_args);
	JS_FreeValue(l->jsc, l->dispatch);
	JS_FreeValue(l->jsc, l->map_entries_fn);
	JS_FreeValue(l->jsc, l->lua_table_build_fn);
	JS_FreeValue(l->jsc, l->lua_table_parts_fn);
	JS_FreeContext(l->jsc);
	JS_FreeRuntime(l->rt);
	skynet_free(l);
}

MODAPI void
snjs_signal(struct snjs *l, int signal) {
	if (signal == 1) {
		skynet_error(l->ctx, "Current JS memory %.3f K", (float)l->mem / 1024);
	} else {
		// arm the interrupt trap; see file header comment
		ATOM_STORE(&l->trap, 1);
	}
}
