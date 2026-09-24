#ifndef SNJS_INTERNAL_H
#define SNJS_INTERNAL_H

/*
 * Shared internal state of the snjs service module. snjs.c owns the struct;
 * js-seri.c (and later extensions) attach to it. Not part of the module ABI:
 * only snjs_* symbols are exported.
 */

#include <quickjs.h>
#include "atomic.h"

struct skynet_context;
struct skynet_socket_message;
struct np_queue;

struct snjs {
	JSRuntime *rt;
	JSContext *jsc;
	struct skynet_context *ctx;   // declared in skynet.h/skynet_server.h
	size_t mem;
	size_t mem_report;
	size_t mem_limit;
	ATOM_INT trap;
	JSValue dispatch;
	int js_managed;   // skynet.js loaded: responses are sent from JS (__snjs_wrap)
	char *runtime_args;       // actor-local service args for skynetcore.runtime.argv()

	// js-seri helpers (evaluated in js_seri_init)
	JSValue map_entries_fn;      // (m) => flat [k0,v0,...] | null (Map pack sugar)
	JSValue lua_table_build_fn;  // (array, hashFlat) => LuaTable (unpack target)
	JSValue lua_table_parts_fn;  // (v) => [arrayRef, hashFlat] | null (LuaTable pack)

	// js-netpack: gateserver frame buffer (lazily allocated per service)
	struct np_queue *netpack_q;   // 2-byte framed packet ring + per-fd reassembly
	int socket_netpack;           // socket DATA is routed through js_netpack_dispatch
};

// js-runtime.c exports (owned by register_bridge / init / release)
void js_runtime_set_args(struct snjs *l, const char *args, size_t sz);
void register_runtime_bridge(struct snjs *l, JSValue obj);
void register_runtime_module_bridge(struct snjs *l);

// js-seri.c exports (used by snjs.c's register_bridge and init)
int js_seri_init(struct snjs *l);
JSValue js_seri_pack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_seri_unpack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_seri_ab2str(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

// js-netpack.c exports (gateserver frame buffer; see register_bridge and worker_cb)
int js_netpack_dispatch(struct snjs *l, struct skynet_socket_message *sm, size_t sz, JSValue *out);
void js_netpack_free(struct snjs *l);
JSValue js_netpack_pop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_netpack_pack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
JSValue js_netpack_clear(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

// js-crypto.c exports (crypto namespace, see register_crypto_bridge)
void register_crypto_bridge(JSContext *ctx, JSValue global);

// js-tls.c exports (TLS namespace, only when USE_OPENSSL is defined)
#ifdef USE_OPENSSL
void register_tls_bridge(JSContext *ctx, JSValue global);
#endif

// js-io.c exports (io namespace, see register_io_bridge)
void register_io_bridge(JSContext *ctx, JSValue global);

#endif
