/*
 * js-seri.c -- lua-seri compatible binary serialization for skyjs (Task 5).
 *
 * The stream core (write_block/read_block and the type/cookie format) is
 * copied verbatim from 3rd/skynet/lualib-src/lua-seri.c so bytes match the
 * original byte for byte. The value walking is rewritten from the Lua stack
 * onto JSValue:
 *
 *   Lua nil      <-> JS null/undefined        (null values vanish, like Lua)
 *   boolean      <-> boolean
 *   integer      <-> number when |v| fits an exact double, else BigInt
 *   qword        <-> BigInt (always, preserves >2^53)
 *   real         <-> number (non-integer)
 *   string       <-> string (UTF-8; arbitrary binary needs ArrayBuffer in JS)
 *   table        <-> LuaTable {array:[...0-based...], hash:Map} (lossless target)
 *
 * A Lua table is one value carrying an array segment (keys 1..n) plus a hash
 * segment; JS has three container types, so the mapping is asymmetric:
 *   - unpack (decode): EVERY table becomes a LuaTable, so the receive side is
 *     unambiguous (no Array-vs-Map flip, no empty-collapse, integer hash keys
 *     stay numbers). Empty table -> LuaTable([], new Map()).
 *   - pack (encode): LuaTable is the canonical, byte-optimal source; JS Array
 *     (pure array segment), Map (hash pairs) and Object (string-keyed hash) are
 *     accepted as convenience sugar but all read back as LuaTable.
 *   userdata     <-> error (pointers never cross VMs)
 *
 * Map iteration is impossible through plain C property APIs, so the helpers
 * below are evaluated once in JS (js_seri_init) and called back from C.
 */

#include <quickjs.h>

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "skynet.h"
#include "skynet_malloc.h"
#include "snjs-internal.h"

#define TYPE_NIL 0
#define TYPE_BOOLEAN 1
// hibits 0 false 1 true
#define TYPE_NUMBER 2
// hibits 0 : 0 , 1: byte, 2:word, 4: dword, 6: qword, 8 : double
#define TYPE_NUMBER_ZERO 0
#define TYPE_NUMBER_BYTE 1
#define TYPE_NUMBER_WORD 2
#define TYPE_NUMBER_DWORD 4
#define TYPE_NUMBER_QWORD 6
#define TYPE_NUMBER_REAL 8

#define TYPE_USERDATA 3
#define TYPE_SHORT_STRING 4
// hibits 0~31 : len
#define TYPE_LONG_STRING 5
#define TYPE_TABLE 6

#define MAX_COOKIE 32
#define COMBINE_TYPE(t, v) ((t) | (v) << 3)

#define WB_INIT_CAP 512
#define MAX_DEPTH 32

/* ----------------------------- stream core (byte format identical to lua-seri.c) --- */

/*
 * The stream layout (type cookies, length prefixes, block content) matches
 * lua-seri.c byte for byte; only the write backing differs: a single
 * geometrically grown buffer from the runtime's accounting allocator (pack
 * payloads count toward mem accounting/memlimit) instead of a 128-byte block
 * chain of skynet_malloc blocks.
 */

struct write_block {
	JSRuntime *rt;   // backing memory comes from the runtime's accounting allocator
	uint8_t *buf;
	int64_t len;
	int64_t cap;
	int oom;   // allocation failed: wb_push becomes a no-op, caller checks
};

#define WB_MAX_CAP (256 * 1024 * 1024)  // 256 MB hard ceiling for write_block

struct read_block {
	char *buffer;
	int len;
	int ptr;
};

inline static void
wb_push(struct write_block *b, const void *buf, int sz) {
	if (b->oom) return;
	if (b->len + sz > b->cap) {
		int64_t ncap = b->cap * 2;
		while (ncap < b->len + sz) ncap *= 2;
		if (ncap > WB_MAX_CAP) {
			b->oom = 1;
			return;
		}
		uint8_t *nbuf = js_realloc_rt(b->rt, b->buf, (size_t)ncap);
		if (nbuf == NULL) {
			b->oom = 1;
			return;
		}
		b->buf = nbuf;
		b->cap = ncap;
	}
	memcpy(b->buf + b->len, buf, sz);
	b->len += sz;
}

static void
wb_init(struct write_block *wb, JSRuntime *rt) {
	wb->rt = rt;
	wb->cap = WB_INIT_CAP;
	wb->buf = js_malloc_rt(wb->rt, wb->cap);
	wb->len = 0;
	wb->oom = (wb->buf == NULL);
}

static void
wb_free(struct write_block *wb) {
	js_free_rt(wb->rt, wb->buf);   // idempotent: buf is NULLed so callers may retry
	wb->buf = NULL;
	wb->len = 0;
	wb->cap = 0;
}

static void
rball_init(struct read_block *rb, char *buffer, int size) {
	rb->buffer = buffer;
	rb->len = size;
	rb->ptr = 0;
}

static const void *
rb_read(struct read_block *rb, int sz) {
	if (rb->len < sz) {
		return NULL;
	}
	int ptr = rb->ptr;
	rb->ptr += sz;
	rb->len -= sz;
	return rb->buffer + ptr;
}

/* ----------------------------- primitives (format-identical) ------------ */

inline static void
wb_nil(struct write_block *wb) {
	uint8_t n = TYPE_NIL;
	wb_push(wb, &n, 1);
}

inline static void
wb_boolean(struct write_block *wb, int boolean) {
	uint8_t n = COMBINE_TYPE(TYPE_BOOLEAN, boolean ? 1 : 0);
	wb_push(wb, &n, 1);
}

inline static void
wb_integer(struct write_block *wb, int64_t v) {
	// type byte + value staged in one buffer, single push (format identical
	// to the per-field pushes of lua-seri.c)
	uint8_t tmp[9];
	if (v == 0) {
		tmp[0] = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_ZERO);
		wb_push(wb, tmp, 1);
	} else if (v != (int32_t)v) {
		tmp[0] = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_QWORD);
		memcpy(tmp + 1, &v, sizeof(v));
		wb_push(wb, tmp, 9);
	} else if (v < 0) {
		int32_t v32 = (int32_t)v;
		tmp[0] = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_DWORD);
		memcpy(tmp + 1, &v32, sizeof(v32));
		wb_push(wb, tmp, 5);
	} else if (v < 0x100) {
		tmp[0] = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_BYTE);
		tmp[1] = (uint8_t)v;
		wb_push(wb, tmp, 2);
	} else if (v < 0x10000) {
		uint16_t word = (uint16_t)v;
		tmp[0] = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_WORD);
		memcpy(tmp + 1, &word, sizeof(word));
		wb_push(wb, tmp, 3);
	} else {
		uint32_t v32 = (uint32_t)v;
		tmp[0] = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_DWORD);
		memcpy(tmp + 1, &v32, sizeof(v32));
		wb_push(wb, tmp, 5);
	}
}

inline static void
wb_real(struct write_block *wb, double v) {
	uint8_t n = COMBINE_TYPE(TYPE_NUMBER, TYPE_NUMBER_REAL);
	wb_push(wb, &n, 1);
	wb_push(wb, &v, sizeof(v));
}

inline static void
wb_string(struct write_block *wb, const char *str, int len) {
	if (len < MAX_COOKIE) {
		uint8_t n = COMBINE_TYPE(TYPE_SHORT_STRING, len);
		wb_push(wb, &n, 1);
		if (len > 0) {
			wb_push(wb, str, len);
		}
	} else {
		uint8_t n;
		if (len < 0x10000) {
			n = COMBINE_TYPE(TYPE_LONG_STRING, 2);
			wb_push(wb, &n, 1);
			uint16_t x = (uint16_t)len;
			wb_push(wb, &x, 2);
		} else {
			n = COMBINE_TYPE(TYPE_LONG_STRING, 4);
			wb_push(wb, &n, 1);
			uint32_t x = (uint32_t)len;
			assert(x == len);
			wb_push(wb, &x, 4);
		}
		wb_push(wb, str, len);
	}
}

static int64_t
get_integer(struct read_block *rb, int cookie, bool *err) {
	*err = false;
	switch (cookie) {
	case TYPE_NUMBER_ZERO:
		return 0;
	case TYPE_NUMBER_BYTE: {
		const uint8_t *pn = (const uint8_t *)rb_read(rb, sizeof(uint8_t));
		if (pn == NULL) { *err = true; return 0; }
		return (int64_t)*pn;
	}
	case TYPE_NUMBER_WORD: {
		const uint16_t *pn = (const uint16_t *)rb_read(rb, sizeof(uint16_t));
		if (pn == NULL) { *err = true; return 0; }
		uint16_t n;
		memcpy(&n, pn, sizeof(n));
		return n;
	}
	case TYPE_NUMBER_DWORD: {
		const int32_t *pn = (const int32_t *)rb_read(rb, sizeof(int32_t));
		if (pn == NULL) { *err = true; return 0; }
		int32_t n;
		memcpy(&n, pn, sizeof(n));
		return n;
	}
	case TYPE_NUMBER_QWORD: {
		const int64_t *pn = (const int64_t *)rb_read(rb, sizeof(int64_t));
		if (pn == NULL) { *err = true; return 0; }
		int64_t n;
		memcpy(&n, pn, sizeof(n));
		return n;
	}
	default:
		*err = true;
		return 0;
	}
}

static double
get_real(struct read_block *rb, bool *err) {
	double n = 0;
	*err = false;
	const void *pn = rb_read(rb, sizeof(n));
	if (pn == NULL) {
		*err = true;
		return 0;
	}
	memcpy(&n, pn, sizeof(n));
	return n;
}

/* ----------------------------- pack ------------------------------------- */

static JSValue
seri_error(JSContext *ctx, struct write_block *b, const char *fmt, int line) {
	wb_free(b);
	return JS_ThrowTypeError(ctx, "seri error (%s:%d)", fmt, line);
}

static int
pack_one(JSContext *ctx, struct snjs *l, struct write_block *b, JSValueConst v, int depth);

// TYPE_TABLE cookie header: the array-segment length is inlined into the cookie
// (0..MAX_COOKIE-2) or spilled as a trailing integer (MAX_COOKIE-1 escape).
static void
wb_table_header(struct write_block *b, int32_t arr_len) {
	if (arr_len >= MAX_COOKIE - 1) {
		uint8_t n = COMBINE_TYPE(TYPE_TABLE, MAX_COOKIE - 1);
		wb_push(b, &n, 1);
		wb_integer(b, arr_len);
	} else {
		uint8_t n = COMBINE_TYPE(TYPE_TABLE, (uint8_t)arr_len);
		wb_push(b, &n, 1);
	}
}

// Object own enumerable string properties -> hash part
static int
pack_object(JSContext *ctx, struct snjs *l, struct write_block *b, JSValueConst v, int depth) {
	JSPropertyEnum *tab = NULL;
	uint32_t nprops = 0;
	if (JS_GetOwnPropertyNames(ctx, &tab, &nprops, v, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
		wb_free(b);
		return -1;
	}
	// hash-only table: still needs the TYPE_TABLE cookie header
	uint8_t hdr = COMBINE_TYPE(TYPE_TABLE, 0);
	wb_push(b, &hdr, 1);
	for (uint32_t i = 0; i < nprops; i++) {
		JSValue k = JS_AtomToValue(ctx, tab[i].atom);
		JSValue val = JS_GetProperty(ctx, v, tab[i].atom);
		int r1 = pack_one(ctx, l, b, k, depth + 1);
		int r2 = pack_one(ctx, l, b, val, depth + 1);
		JS_FreeValue(ctx, k);
		JS_FreeValue(ctx, val);
		if (r1 || r2) {
			JS_FreePropertyEnum(ctx, tab, nprops);
			return -1;
		}
	}
	JS_FreePropertyEnum(ctx, tab, nprops);
	wb_nil(b);
	return 0;
}

static int
pack_one(JSContext *ctx, struct snjs *l, struct write_block *b, JSValueConst v, int depth) {
	if (depth > MAX_DEPTH) {
		seri_error(ctx, b, "pack too deep", __LINE__);
		return -1;
	}
	if (JS_IsNull(v) || JS_IsUndefined(v)) {
		wb_nil(b);
		return 0;
	}
	if (JS_IsBigInt(v)) {
		int64_t iv;
		if (JS_ToInt64Ext(ctx, &iv, v)) {
			wb_free(b);
			return -1;
		}
		wb_integer(b, iv);
		return 0;
	}
	if (JS_IsNumber(v)) {
		double dv;
		if (JS_ToFloat64(ctx, &dv, v)) {
			wb_free(b);
			return -1;
		}
		// exact integers (|v| <= 2^53) take the integer path, like Lua 5.5
		const double LIMIT = 9007199254740992.0;
		if (dv >= -LIMIT && dv <= LIMIT && dv == (double)(int64_t)dv) {
			wb_integer(b, (int64_t)dv);
		} else {
			wb_real(b, dv);
		}
		return 0;
	}
	if (JS_IsBool(v)) {
		wb_boolean(b, JS_VALUE_GET_BOOL(v));
		return 0;
	}
	if (JS_IsString(v)) {
		size_t sz = 0;
		const char *s = JS_ToCStringLen(ctx, &sz, v);
		if (s == NULL) {
			wb_free(b);
			return -1;
		}
		if (sz > 0x7fffffff) {
			JS_FreeCString(ctx, s);
			seri_error(ctx, b, "string too long", __LINE__);
			return -1;
		}
		wb_string(b, s, (int)sz);
		JS_FreeCString(ctx, s);
		return 0;
	}
	if (JS_IsArray(v)) {
		JSValue lenv = JS_GetPropertyStr(ctx, v, "length");
		int32_t arr_len = 0;
		JS_ToInt32(ctx, &arr_len, lenv);
		JS_FreeValue(ctx, lenv);
		if (arr_len < 0) {
			seri_error(ctx, b, "negative array length", __LINE__);
			return -1;
		}
		wb_table_header(b, arr_len);
		for (int32_t i = 0; i < arr_len; i++) {
			JSValue elem = JS_GetPropertyUint32(ctx, v, (uint32_t)i);
			int r = pack_one(ctx, l, b, elem, depth + 1);
			JS_FreeValue(ctx, elem);
			if (r) {
				wb_free(b);   // idempotent: nested failures may have freed already
				return -1;
			}
		}
		wb_nil(b);	// hash terminator (empty hash part)
		return 0;
	}
	if (JS_IsObject(v)) {
		// LuaTable? (explicit {array, hash} wrapper: lossless + byte-optimal,
		// emits the array segment then the hash pairs exactly like lua-seri)
		JSValue parts = JS_Call(ctx, l->lua_table_parts_fn, JS_UNDEFINED, 1, (JSValueConst *)&v);
		if (JS_IsException(parts)) {
			wb_free(b);
			return -1;
		}
		if (!JS_IsNull(parts)) {
			JSValue arr = JS_GetPropertyUint32(ctx, parts, 0);
			JSValue hashflat = JS_GetPropertyUint32(ctx, parts, 1);
			JS_FreeValue(ctx, parts);
			// array segment
			JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
			int32_t arr_len = 0;
			JS_ToInt32(ctx, &arr_len, lenv);
			JS_FreeValue(ctx, lenv);
			if (arr_len < 0) {
				JS_FreeValue(ctx, arr);
				JS_FreeValue(ctx, hashflat);
				seri_error(ctx, b, "negative array length", __LINE__);
				return -1;
			}
			wb_table_header(b, arr_len);
			for (int32_t i = 0; i < arr_len; i++) {
				JSValue elem = JS_GetPropertyUint32(ctx, arr, (uint32_t)i);
				int r = pack_one(ctx, l, b, elem, depth + 1);
				JS_FreeValue(ctx, elem);
				if (r) {
					JS_FreeValue(ctx, arr);
					JS_FreeValue(ctx, hashflat);
					wb_free(b);
					return -1;
				}
			}
			JS_FreeValue(ctx, arr);
			// hash segment: hashflat is flat [k0,v0,k1,v1,...]
			JSValue hlenv = JS_GetPropertyStr(ctx, hashflat, "length");
			int32_t hn = 0;
			JS_ToInt32(ctx, &hn, hlenv);
			JS_FreeValue(ctx, hlenv);
			for (int32_t i = 0; i < hn; i += 2) {
				JSValue k = JS_GetPropertyUint32(ctx, hashflat, (uint32_t)i);
				JSValue val = JS_GetPropertyUint32(ctx, hashflat, (uint32_t)(i + 1));
				int r1 = pack_one(ctx, l, b, k, depth + 1);
				int r2 = pack_one(ctx, l, b, val, depth + 1);
				JS_FreeValue(ctx, k);
				JS_FreeValue(ctx, val);
				if (r1 || r2) {
					JS_FreeValue(ctx, hashflat);
					wb_free(b);
					return -1;
				}
			}
			JS_FreeValue(ctx, hashflat);
			wb_nil(b);
			return 0;
		}
		JS_FreeValue(ctx, parts);
		// Map? (C property APIs can't see Map slots; use the JS helper)
		JSValue entries = JS_Call(ctx, l->map_entries_fn, JS_UNDEFINED, 1, (JSValueConst *)&v);
		if (JS_IsException(entries)) {
			wb_free(b);
			return -1;
		}
		if (!JS_IsNull(entries)) {
			// entries is flat [k0,v0,k1,v1,...]; iterate with stride 2
			uint8_t hdr = COMBINE_TYPE(TYPE_TABLE, 0);
			wb_push(b, &hdr, 1);
			JSValue lenv = JS_GetPropertyStr(ctx, entries, "length");
			int32_t n = 0;
			JS_ToInt32(ctx, &n, lenv);
			JS_FreeValue(ctx, lenv);
			for (int32_t i = 0; i < n; i += 2) {
				JSValue k = JS_GetPropertyUint32(ctx, entries, (uint32_t)i);
				JSValue val = JS_GetPropertyUint32(ctx, entries, (uint32_t)(i + 1));
				int r1 = pack_one(ctx, l, b, k, depth + 1);
				int r2 = pack_one(ctx, l, b, val, depth + 1);
				JS_FreeValue(ctx, k);
				JS_FreeValue(ctx, val);
				if (r1 || r2) {
					JS_FreeValue(ctx, entries);
					wb_free(b);
					return -1;
				}
			}
			JS_FreeValue(ctx, entries);
			wb_nil(b);
			return 0;
		}
		JS_FreeValue(ctx, entries);
		return pack_object(ctx, l, b, v, depth);
	}
	seri_error(ctx, b, "unsupported type", __LINE__);
	return -1;
}

/* ----------------------------- unpack ----------------------------------- */

static JSValue
unpack_one(JSContext *ctx, struct snjs *l, struct read_block *rb);

static JSValue
unpack_table(JSContext *ctx, struct snjs *l, struct read_block *rb, int array_size) {
	if (array_size == MAX_COOKIE - 1) {
		const uint8_t *t = (const uint8_t *)rb_read(rb, sizeof(uint8_t));
		if (t == NULL) {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		int type = *t & 0x7;
		int cookie = *t >> 3;
		if (type != TYPE_NUMBER || cookie == TYPE_NUMBER_REAL) {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		bool err;
		int64_t n = get_integer(rb, cookie, &err);
		if (err) {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		array_size = (int)n;
	}

	// Array segment -> a 0-based JS Array (built directly in C).
	JSValue array = JS_NewArray(ctx);
	for (int i = 0; i < array_size; i++) {
		JSValue e = unpack_one(ctx, l, rb);
		if (JS_IsException(e)) {
			JS_FreeValue(ctx, array);
			return JS_EXCEPTION;
		}
		JS_DefinePropertyValueUint32(ctx, array, (uint32_t)i, e, 0);
	}

	// Hash segment -> flat [k0,v0,k1,v1,...]; TYPE_NIL key = no hash part.
	JSValue hashflat = JS_NewArray(ctx);
	int64_t idx = 0;
	for (;;) {
		JSValue k = unpack_one(ctx, l, rb);
		if (JS_IsException(k)) {
			JS_FreeValue(ctx, array);
			JS_FreeValue(ctx, hashflat);
			return k;
		}
		if (JS_IsNull(k)) {
			JS_FreeValue(ctx, k);
			break;
		}
		JSValue v = unpack_one(ctx, l, rb);
		if (JS_IsException(v)) {
			JS_FreeValue(ctx, k);
			JS_FreeValue(ctx, array);
			JS_FreeValue(ctx, hashflat);
			return v;
		}
		JS_DefinePropertyValueUint32(ctx, hashflat, (uint32_t)idx++, k, 0);
		JS_DefinePropertyValueUint32(ctx, hashflat, (uint32_t)idx++, v, 0);
	}

	// Every table decodes to a LuaTable (array segment + hash Map), so the
	// receive side is unambiguous. Empty table -> LuaTable([], new Map()).
	JSValueConst args[2] = { array, hashflat };
	JSValue lt = JS_Call(ctx, l->lua_table_build_fn, JS_UNDEFINED, 2, args);
	JS_FreeValue(ctx, array);
	JS_FreeValue(ctx, hashflat);
	return lt;
}

static JSValue
unpack_value(JSContext *ctx, struct snjs *l, struct read_block *rb, int type, int cookie) {
	switch (type) {
	case TYPE_NIL:
		return JS_NULL;
	case TYPE_BOOLEAN:
		return JS_NewBool(ctx, cookie);
	case TYPE_NUMBER:
		if (cookie == TYPE_NUMBER_REAL) {
			bool err;
			double d = get_real(rb, &err);
			if (err) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			return JS_NewFloat64(ctx, d);
		}
		{
			bool err;
			int64_t iv = get_integer(rb, cookie, &err);
			if (err) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			if (cookie == TYPE_NUMBER_QWORD) {
				return JS_NewBigInt64(ctx, iv);
			}
			return JS_NewInt64(ctx, iv);
		}
	case TYPE_USERDATA:
		return JS_ThrowTypeError(ctx, "seri: userdata can't cross VMs");
	case TYPE_SHORT_STRING: {
		const char *p = (const char *)rb_read(rb, cookie);
		if (p == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		return JS_NewStringLen(ctx, p, (size_t)cookie);
	}
	case TYPE_LONG_STRING: {
		uint32_t len;
		if (cookie == 2) {
			const uint16_t *plen = (const uint16_t *)rb_read(rb, 2);
			if (plen == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			uint16_t n;
			memcpy(&n, plen, sizeof(n));
			len = n;
		} else if (cookie == 4) {
			const uint32_t *plen = (const uint32_t *)rb_read(rb, 4);
			if (plen == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
			uint32_t n;
			memcpy(&n, plen, sizeof(n));
			len = n;
		} else {
			return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		}
		const char *p = (const char *)rb_read(rb, (int)len);
		if (p == NULL) return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
		return JS_NewStringLen(ctx, p, (size_t)len);
	}
	case TYPE_TABLE:
		return unpack_table(ctx, l, rb, cookie);
	default:
		return JS_ThrowTypeError(ctx, "Invalid serialize stream type %d", type);
	}
}

static JSValue
unpack_one(JSContext *ctx, struct snjs *l, struct read_block *rb) {
	const uint8_t *t = (const uint8_t *)rb_read(rb, sizeof(uint8_t));
	if (t == NULL) {
		return JS_ThrowTypeError(ctx, "Invalid serialize stream (%d)", __LINE__);
	}
	return unpack_value(ctx, l, rb, *t & 0x7, *t >> 3);
}

/* ----------------------------- JS bridge -------------------------------- */

// ArrayBuffer backed by a runtime-allocator buffer: the runtime hands the
// data pointer back through this hook for resize (size > 0) and for the
// final free (size == 0), per quickjs-ng's JSReallocArrayBufferDataFunc.
static void *
js_seri_buffer_realloc(JSRuntime *rt, void *opaque, void *ptr, size_t size) {
	(void)opaque;
	if (size == 0) {
		js_free_rt(rt, ptr);
		return NULL;
	}
	return js_realloc_rt(rt, ptr, size);
}

// pack(...values) -> ArrayBuffer
JSValue
js_seri_pack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = JS_GetContextOpaque(ctx);
	(void)this_val;
	struct write_block wb;
	wb_init(&wb, l->rt);
	for (int i = 0; i < argc; i++) {
		if (pack_one(ctx, l, &wb, argv[i], 0)) {
			// cleanup already handled inside pack_one (wb_free is idempotent)
			return JS_EXCEPTION;
		}
	}
	if (wb.oom) {
		wb_free(&wb);
		return JS_ThrowOutOfMemory(ctx);
	}
	// zero-copy handoff: the ArrayBuffer adopts wb.buf; freeing goes through
	// js_seri_buffer_realloc (same accounting allocator) when collected
	JSValue ab = JS_NewArrayBuffer(ctx, wb.buf, (size_t)wb.len, 0,
		js_seri_buffer_realloc, NULL, 0);
	if (JS_IsException(ab)) {
		wb_free(&wb);
	}
	return ab;
}

// unpack(ArrayBuffer | string) -> Array of values
JSValue
js_seri_unpack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = JS_GetContextOpaque(ctx);
	(void)this_val;
	char *buffer = NULL;
	int len = 0;
	size_t bsz = 0;
	if (JS_IsArrayBuffer(argv[0])) {
		uint8_t *p = JS_GetArrayBuffer(ctx, &bsz, argv[0]);
		if (p == NULL) return JS_EXCEPTION;
		buffer = (char *)p;
		len = (int)bsz;
	} else if (JS_IsString(argv[0])) {
		size_t ssz = 0;
		const char *s = JS_ToCStringLen(ctx, &ssz, argv[0]);
		if (s == NULL) return JS_EXCEPTION;
		buffer = skynet_malloc(ssz);
		memcpy(buffer, s, ssz);
		JS_FreeCString(ctx, s);
		len = (int)ssz;
	} else {
		return JS_ThrowTypeError(ctx, "unpack expects ArrayBuffer or string");
	}
	if (len == 0) {
		if (buffer != (char *)0 && JS_IsString(argv[0])) skynet_free(buffer);
		return JS_NewArray(ctx);
	}
	struct read_block rb;
	rball_init(&rb, buffer, len);
	JSValue out = JS_NewArray(ctx);
	int64_t idx = 0;
	for (;;) {
		const uint8_t *t = (const uint8_t *)rb_read(&rb, sizeof(uint8_t));
		if (t == NULL) break;
		JSValue v = unpack_value(ctx, l, &rb, *t & 0x7, *t >> 3);
		if (JS_IsException(v)) {
			JS_FreeValue(ctx, out);
			if (JS_IsString(argv[0])) skynet_free(buffer);
			return v;
		}
		// fast define path; consumes v (owned by out afterwards)
		JS_DefinePropertyValueUint32(ctx, out, (uint32_t)idx++, v, 0);
	}
	if (JS_IsString(argv[0])) skynet_free(buffer);
	return out;
}

// ab2str(ArrayBuffer) -> string (UTF-8 decode of raw bytes)
JSValue
js_seri_ab2str(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val; (void)argc;
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[0]);
	if (p == NULL) return JS_EXCEPTION;
	return JS_NewStringLen(ctx, (const char *)p, sz);
}

// evaluated once in JS: the LuaTable class + Map/LuaTable pack/unpack helpers.
// Defined here (not in skynet.js) so LuaTable exists regardless of loader order.
static const char *seri_helpers_js =
	"globalThis.LuaTable = class LuaTable {\n"
	"    constructor(array, hash) {\n"
	"        this.array = array || [];\n"
	"        this.hash = hash instanceof Map ? hash : new Map();\n"
	"    }\n"
	"    get len() { return this.array.length; }\n"
	"    get(k) {\n"
	"        if (typeof k === 'number' && Number.isInteger(k) && k >= 1 && k <= this.array.length) return this.array[k - 1];\n"
	"        return this.hash.get(k);\n"
	"    }\n"
	"    set(k, v) {\n"
	"        if (typeof k === 'number' && Number.isInteger(k) && k >= 1 && k <= this.array.length + 1) this.array[k - 1] = v;\n"
	"        else this.hash.set(k, v);\n"
	"        return this;\n"
	"    }\n"
	"    entries() {\n"
	"        const out = [];\n"
	"        for (let i = 0; i < this.array.length; i++) out.push([i + 1, this.array[i]]);\n"
	"        for (const e of this.hash) out.push(e);\n"
	"        return out;\n"
	"    }\n"
	"    [Symbol.iterator]() { return this.entries()[Symbol.iterator](); }\n"
	"    toJSON() {\n"
	"        const o = {};\n"
	"        for (let i = 0; i < this.array.length; i++) o[i + 1] = this.array[i];\n"
	"        this.hash.forEach(function (v, k) { o[k] = v; });\n"
	"        return o;\n"
	"    }\n"
	"};\n"
	"globalThis.__snjs_seri = {\n"
	"    entries: function (m) {\n"
	"        if (!(m instanceof Map)) return null;\n"
	"        var flat = new Array(m.size * 2);\n"
	"        var i = 0;\n"
	"        m.forEach(function(v, k) { flat[i++] = k; flat[i++] = v; });\n"
	"        return flat;\n"
	"    },\n"
	"    buildluatable: function (array, hashFlat) {\n"
	"        var m = new Map();\n"
	"        for (var i = 0; i < hashFlat.length; i += 2) m.set(hashFlat[i], hashFlat[i + 1]);\n"
	"        return new globalThis.LuaTable(array, m);\n"
	"    },\n"
	"    luatableparts: function (v) {\n"
	"        if (!(v instanceof globalThis.LuaTable)) return null;\n"
	"        var flat = [];\n"
	"        if (v.hash instanceof Map) v.hash.forEach(function (val, k) { flat.push(k, val); });\n"
	"        return [v.array || [], flat];\n"
	"    },\n"
	"};\n";

void
register_seri_bridge(JSContext *ctx, JSValue obj) {
    JSValue seri = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, seri, "pack", JS_NewCFunction(ctx, js_seri_pack, "pack", 0));
    JS_SetPropertyStr(ctx, seri, "unpack", JS_NewCFunction(ctx, js_seri_unpack, "unpack", 1));
    JS_SetPropertyStr(ctx, seri, "str", JS_NewCFunction(ctx, js_seri_ab2str, "str", 1));
    JS_SetPropertyStr(ctx, obj, "seri", seri);
}

int
js_seri_init(struct snjs *l) {
	JSValue ret = JS_Eval(l->jsc, seri_helpers_js, strlen(seri_helpers_js), "<seri>", JS_EVAL_TYPE_GLOBAL);
	if (JS_IsException(ret)) {
		return -1;
	}
	JS_FreeValue(l->jsc, ret);
	JSValue g = JS_GetGlobalObject(l->jsc);
	JSValue obj = JS_GetPropertyStr(l->jsc, g, "__snjs_seri");
	JS_FreeValue(l->jsc, g);
	JSValue entries_fn = JS_GetPropertyStr(l->jsc, obj, "entries");
	JSValue build_fn = JS_GetPropertyStr(l->jsc, obj, "buildluatable");
	JSValue parts_fn = JS_GetPropertyStr(l->jsc, obj, "luatableparts");
	l->map_entries_fn = JS_DupValue(l->jsc, entries_fn);
	l->lua_table_build_fn = JS_DupValue(l->jsc, build_fn);
	l->lua_table_parts_fn = JS_DupValue(l->jsc, parts_fn);
	JS_FreeValue(l->jsc, entries_fn);
	JS_FreeValue(l->jsc, build_fn);
	JS_FreeValue(l->jsc, parts_fn);
	JS_FreeValue(l->jsc, obj);
	return 0;
}
