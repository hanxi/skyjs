/*
 * js-net.c -- skynetcore net namespace.
 *
 * Owns the socket bridge and the netpack frame buffer (a JS-facing port of
 * 3rd/skynet/lualib-src/lua-netpack.c, byte-compatible 2-byte big-endian
 * length framing + per-fd reassembly + a ring queue).
 *
 * Netpack queue ownership: a PTYPE_SOCKET DATA event's sm->buffer is a fresh
 * skynet_malloc block owned by the service; js_netpack_dispatch takes it over
 * (zero-copy) and frees it in filter_data, and reassembled packets are freed
 * on pop/clear. Control events (buffer == NULL) keep their text inside the
 * outer skynet_socket_message and are freed by the framework, never here.
 */

#include <quickjs.h>

#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "skynet.h"
#include "skynet_server.h"
#include "skynet_malloc.h"
#include "skynet_socket.h"
#include "snjs-internal.h"

static struct snjs *
getinst(JSContext *ctx) {
	return JS_GetContextOpaque(ctx);
}

/* ------------------------------------------------------- socket bridge */

static JSValue
js_sock_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *host = JS_ToCString(ctx, argv[0]);
	if (host == NULL) return JS_EXCEPTION;
	int32_t port, backlog = 64;
	if (JS_ToInt32(ctx, &port, argv[1])) { JS_FreeCString(ctx, host); return JS_EXCEPTION; }
	if (argc > 2) JS_ToInt32(ctx, &backlog, argv[2]);
	int id = skynet_socket_listen(l->ctx, host, port, backlog);
	JS_FreeCString(ctx, host);
	return JS_NewInt32(ctx, id);
}

static JSValue
js_sock_connect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	const char *host = JS_ToCString(ctx, argv[0]);
	if (host == NULL) return JS_EXCEPTION;
	int32_t port;
	if (JS_ToInt32(ctx, &port, argv[1])) { JS_FreeCString(ctx, host); return JS_EXCEPTION; }
	int id = skynet_socket_connect(l->ctx, host, port);
	JS_FreeCString(ctx, host);
	return JS_NewInt32(ctx, id);
}

static JSValue
js_sock_start(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_start(l->ctx, id);
	return JS_UNDEFINED;
}

// send(id, data): buffer ownership transfers to the socket layer. data may be
// a string (UTF-8) or an ArrayBuffer (binary-safe, per-connection binary).
static JSValue
js_sock_send(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val;
	if (argc < 2) {
		return JS_ThrowTypeError(ctx, "skynetcore.socket.send(id, data)");
	}
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	size_t sz = 0;
	void *buf = NULL;
	if (JS_IsArrayBuffer(argv[1])) {
		uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[1]);
		if (p == NULL) return JS_EXCEPTION;
		buf = skynet_malloc(sz);
		memcpy(buf, p, sz);
	} else {
		const char *data = JS_ToCStringLen(ctx, &sz, argv[1]);
		if (data == NULL) return JS_EXCEPTION;
		buf = skynet_malloc(sz);
		memcpy(buf, data, sz);
		JS_FreeCString(ctx, data);
	}
	int r = skynet_socket_send(l->ctx, id, buf, (int)sz);
	return JS_NewInt32(ctx, r);
}

static JSValue
js_sock_nodelay(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_nodelay(l->ctx, id);
	return JS_UNDEFINED;
}

// enable netpack mode: PTYPE_SOCKET DATA is routed through the C frame buffer
// (js_netpack_dispatch) instead of being delivered as a raw payload. Used by
// gateserver.js; one flag per service (a service is either a gate or not).
static JSValue
js_sock_netpack_mode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc; (void)argv;
	l->socket_netpack = 1;
	return JS_UNDEFINED;
}

static JSValue
js_sock_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_close(l->ctx, id);
	return JS_UNDEFINED;
}

static JSValue
js_sock_shutdown(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = getinst(ctx);
	(void)this_val; (void)argc;
	int32_t id;
	if (JS_ToInt32(ctx, &id, argv[0])) return JS_EXCEPTION;
	skynet_socket_shutdown(l->ctx, id);
	return JS_UNDEFINED;
}


#define QUEUESIZE 1024
#define HASHSIZE 4096

/* filter_data result codes */
#define NP_NONE 0   /* nothing to deliver (uncomplete saved) */
#define NP_DATA 1   /* a single packet; *out_buf / *out_size set (caller frees) */
#define NP_MORE 2   /* multiple packets pushed to the queue; caller drains via pop */

struct np_netpack {
	int id;
	int size;
	void *buffer;
};

struct np_uncomplete {
	struct np_netpack pack;
	struct np_uncomplete *next;
	int read;
	int header;
};

struct np_queue {
	int cap;
	int head;
	int tail;
	struct np_uncomplete *hash[HASHSIZE];
	struct np_netpack queue[];   /* [cap] entries follow */
};

/* ------------------------------------------------------------------ queue */

static struct np_queue *
np_alloc_queue(int cap) {
	struct np_queue *q = skynet_malloc(sizeof(struct np_queue) + cap * sizeof(struct np_netpack));
	q->cap = cap;
	q->head = 0;
	q->tail = 0;
	memset(q->hash, 0, sizeof(q->hash));
	return q;
}

static struct np_queue *
np_get_queue(struct snjs *l) {
	if (l->netpack_q == NULL) {
		l->netpack_q = np_alloc_queue(QUEUESIZE);
	}
	return l->netpack_q;
}

// grow the ring by QUEUESIZE, preserving order; replaces l->netpack_q
static void
np_expand_queue(struct snjs *l, struct np_queue *q) {
	struct np_queue *nq = np_alloc_queue(q->cap + QUEUESIZE);
	nq->head = 0;
	nq->tail = q->cap;
	memcpy(nq->hash, q->hash, sizeof(nq->hash));
	int i;
	for (i = 0; i < q->cap; i++) {
		nq->queue[i] = q->queue[(q->head + i) % q->cap];
	}
	skynet_free(q);
	l->netpack_q = nq;
}

static void
np_push_data(struct snjs *l, int fd, void *buffer, int size, int clone) {
	if (clone) {
		void *tmp = skynet_malloc(size);
		memcpy(tmp, buffer, size);
		buffer = tmp;
	}
	struct np_queue *q = np_get_queue(l);
	struct np_netpack *np = &q->queue[q->tail];
	if (++q->tail >= q->cap)
		q->tail -= q->cap;
	np->id = fd;
	np->buffer = buffer;
	np->size = size;
	if (q->head == q->tail) {
		np_expand_queue(l, q);
	}
}

static inline int
hash_fd(int fd) {
	int a = fd >> 24;
	int b = fd >> 12;
	int c = fd;
	return (int)(((uint32_t)(a + b + c)) % HASHSIZE);
}

static struct np_uncomplete *
find_uncomplete(struct np_queue *q, int fd) {
	if (q == NULL)
		return NULL;
	int h = hash_fd(fd);
	struct np_uncomplete *uc = q->hash[h];
	if (uc == NULL)
		return NULL;
	if (uc->pack.id == fd) {
		q->hash[h] = uc->next;
		return uc;
	}
	struct np_uncomplete *last = uc;
	while (last->next) {
		uc = last->next;
		if (uc->pack.id == fd) {
			last->next = uc->next;
			return uc;
		}
		last = uc;
	}
	return NULL;
}

static struct np_uncomplete *
save_uncomplete(struct snjs *l, int fd) {
	struct np_queue *q = np_get_queue(l);
	int h = hash_fd(fd);
	struct np_uncomplete *uc = skynet_malloc(sizeof(struct np_uncomplete));
	memset(uc, 0, sizeof(*uc));
	uc->next = q->hash[h];
	uc->pack.id = fd;
	q->hash[h] = uc;
	return uc;
}

static inline int
read_size(uint8_t *buffer) {
	int r = (int)buffer[0] << 8 | (int)buffer[1];
	return r;
}

static void
push_more(struct snjs *l, int fd, uint8_t *buffer, int size) {
	while (size > 0) {
		if (size == 1) {
			struct np_uncomplete *uc = save_uncomplete(l, fd);
			uc->read = -1;
			uc->header = *buffer;
			return;
		}
		int pack_size = read_size(buffer);
		buffer += 2;
		size -= 2;

		if (size < pack_size) {
			struct np_uncomplete *uc = save_uncomplete(l, fd);
			uc->read = size;
			uc->pack.size = pack_size;
			uc->pack.buffer = skynet_malloc(pack_size);
			memcpy(uc->pack.buffer, buffer, size);
			return;
		}
		np_push_data(l, fd, buffer, pack_size, 1);

		buffer += pack_size;
		size -= pack_size;
	}
}

static void
np_close_uncomplete(struct snjs *l, int fd) {
	struct np_queue *q = l->netpack_q;
	struct np_uncomplete *uc = find_uncomplete(q, fd);
	if (uc) {
		skynet_free(uc->pack.buffer);
		skynet_free(uc);
	}
}

// reassemble one socket DATA buffer; ownership of `buffer` (a skynet_malloc
// block) transfers here and is freed before return, same as lua's filter_data.
static int
filter_data_(struct snjs *l, int fd, uint8_t *buffer, int size, void **out_buf, int *out_size) {
	struct np_queue *q = l->netpack_q;
	struct np_uncomplete *uc = find_uncomplete(q, fd);
	if (uc) {
		if (uc->read < 0) {
			assert(uc->read == -1);
			int pack_size = *buffer;
			pack_size |= uc->header << 8;
			++buffer;
			--size;
			uc->pack.size = pack_size;
			uc->pack.buffer = skynet_malloc(pack_size);
			uc->read = 0;
		}
		int need = uc->pack.size - uc->read;
		if (size < need) {
			memcpy((char *)uc->pack.buffer + uc->read, buffer, size);
			uc->read += size;
			int h = hash_fd(fd);
			uc->next = q->hash[h];
			q->hash[h] = uc;
			return NP_NONE;
		}
		memcpy((char *)uc->pack.buffer + uc->read, buffer, need);
		buffer += need;
		size -= need;
		if (size == 0) {
			*out_buf = uc->pack.buffer;
			*out_size = uc->pack.size;
			skynet_free(uc);
			return NP_DATA;
		}
		// more data
		np_push_data(l, fd, uc->pack.buffer, uc->pack.size, 0);
		skynet_free(uc);
		push_more(l, fd, buffer, size);
		return NP_MORE;
	} else {
		if (size == 1) {
			struct np_uncomplete *nuc = save_uncomplete(l, fd);
			nuc->read = -1;
			nuc->header = *buffer;
			return NP_NONE;
		}
		int pack_size = read_size(buffer);
		buffer += 2;
		size -= 2;

		if (size < pack_size) {
			struct np_uncomplete *nuc = save_uncomplete(l, fd);
			nuc->read = size;
			nuc->pack.size = pack_size;
			nuc->pack.buffer = skynet_malloc(pack_size);
			memcpy(nuc->pack.buffer, buffer, size);
			return NP_NONE;
		}
		if (size == pack_size) {
			// just one package
			void *result = skynet_malloc(pack_size);
			memcpy(result, buffer, size);
			*out_buf = result;
			*out_size = pack_size;
			return NP_DATA;
		}
		// more data
		np_push_data(l, fd, buffer, pack_size, 1);
		buffer += pack_size;
		size -= pack_size;
		push_more(l, fd, buffer, size);
		return NP_MORE;
	}
}

static int
filter_data(struct snjs *l, int fd, uint8_t *buffer, int size, void **out_buf, int *out_size) {
	int ret = filter_data_(l, fd, buffer, size, out_buf, out_size);
	// buffer is the socket message payload (skynet_malloc'd in
	// socket_server.c forward_message); free it before return.
	skynet_free(buffer);
	return ret;
}

/* ------------------------------------------------------------- dispatch */

// Called from snjs.c worker_cb when the service is in netpack mode. Builds the
// JS event object for socket.js/gateserver.js; returns 1 when *out is set, 0
// when there is nothing to deliver (an uncomplete packet was buffered).
int
js_netpack_dispatch(struct snjs *l, struct skynet_socket_message *sm, size_t sz, JSValue *out) {
	JSContext *ctx = l->jsc;
	char *buffer = sm->buffer;
	int msg_size;
	if (buffer == NULL) {
		buffer = (char *)(sm + 1);
		msg_size = (int)sz - (int)sizeof(*sm);
	} else {
		msg_size = -1;
	}

	if (sm->type == SKYNET_SOCKET_TYPE_DATA) {
		// sm->buffer ownership transfers into filter_data (freed there)
		void *pkt = NULL;
		int psz = 0;
		int r = filter_data(l, sm->id, (uint8_t *)buffer, sm->ud, &pkt, &psz);
		if (r == NP_NONE) {
			*out = JS_UNDEFINED;
			return 0;
		}
		JSValue ev = JS_NewObject(ctx);
		JS_SetPropertyStr(ctx, ev, "np", JS_NewBool(ctx, 1));
		if (r == NP_DATA) {
			JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "data"));
			JS_SetPropertyStr(ctx, ev, "id", JS_NewInt32(ctx, sm->id));
			JS_SetPropertyStr(ctx, ev, "data", JS_NewArrayBufferCopy(ctx, pkt, psz));
			skynet_free(pkt);
		} else {
			JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "more"));
		}
		*out = ev;
		return 1;
	}

	JSValue ev = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, ev, "np", JS_NewBool(ctx, 1));
	switch (sm->type) {
	case SKYNET_SOCKET_TYPE_CONNECT:
		JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "init"));
		JS_SetPropertyStr(ctx, ev, "id", JS_NewInt32(ctx, sm->id));
		JS_SetPropertyStr(ctx, ev, "data", msg_size > 0 ?
			JS_NewStringLen(ctx, buffer, msg_size) : JS_NewString(ctx, ""));
		JS_SetPropertyStr(ctx, ev, "ud", JS_NewInt32(ctx, sm->ud));
		break;
	case SKYNET_SOCKET_TYPE_ACCEPT:
		JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "open"));
		JS_SetPropertyStr(ctx, ev, "id", JS_NewInt32(ctx, sm->ud));   // new connection fd
		JS_SetPropertyStr(ctx, ev, "data", msg_size > 0 ?
			JS_NewStringLen(ctx, buffer, msg_size) : JS_NewString(ctx, ""));
		break;
	case SKYNET_SOCKET_TYPE_CLOSE:
		np_close_uncomplete(l, sm->id);
		JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "close"));
		JS_SetPropertyStr(ctx, ev, "id", JS_NewInt32(ctx, sm->id));
		break;
	case SKYNET_SOCKET_TYPE_ERROR:
		np_close_uncomplete(l, sm->id);
		JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "error"));
		JS_SetPropertyStr(ctx, ev, "id", JS_NewInt32(ctx, sm->id));
		JS_SetPropertyStr(ctx, ev, "data", msg_size > 0 ?
			JS_NewStringLen(ctx, buffer, msg_size) : JS_NewString(ctx, ""));
		break;
	case SKYNET_SOCKET_TYPE_WARNING:
		JS_SetPropertyStr(ctx, ev, "event", JS_NewString(ctx, "warning"));
		JS_SetPropertyStr(ctx, ev, "id", JS_NewInt32(ctx, sm->id));
		JS_SetPropertyStr(ctx, ev, "ud", JS_NewInt32(ctx, sm->ud));
		break;
	default:
		JS_FreeValue(ctx, ev);
		*out = JS_UNDEFINED;
		return 0;
	}
	*out = ev;
	return 1;
}

/* --------------------------------------------------------- JS injected API */

// netpack.pop(): null when empty, else { fd, data:<ArrayBuffer> }. The queue
// buffer's ownership transfers to the new ArrayBuffer copy and is freed here.
JSValue
js_netpack_pop(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = JS_GetContextOpaque(ctx);
	(void)this_val; (void)argc; (void)argv;
	struct np_queue *q = l->netpack_q;
	if (q == NULL || q->head == q->tail)
		return JS_NULL;
	struct np_netpack *np = &q->queue[q->head];
	if (++q->head >= q->cap)
		q->head = 0;
	JSValue o = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, o, "fd", JS_NewInt32(ctx, np->id));
	JS_SetPropertyStr(ctx, o, "data", JS_NewArrayBufferCopy(ctx, np->buffer, np->size));
	skynet_free(np->buffer);
	np->buffer = NULL;
	return o;
}

// netpack.pack(data): prepend a 2-byte big-endian length header (aligns lpack).
JSValue
js_netpack_pack(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	(void)this_val;
	if (argc < 1)
		return JS_ThrowTypeError(ctx, "netpack.pack(data)");
	size_t len = 0;
	const uint8_t *ptr = NULL;
	const char *cstr = NULL;
	if (JS_IsArrayBuffer(argv[0])) {
		ptr = JS_GetArrayBuffer(ctx, &len, argv[0]);
		if (ptr == NULL)
			return JS_EXCEPTION;
	} else {
		cstr = JS_ToCStringLen(ctx, &len, argv[0]);
		if (cstr == NULL)
			return JS_EXCEPTION;
		ptr = (const uint8_t *)cstr;
	}
	if (len >= 0x10000) {
		if (cstr) JS_FreeCString(ctx, cstr);
		return JS_ThrowRangeError(ctx, "netpack.pack: data too long (%u)", (unsigned)len);
	}
	size_t total = len + 2;
	uint8_t *buf = skynet_malloc(total);
	buf[0] = (len >> 8) & 0xff;
	buf[1] = len & 0xff;
	memcpy(buf + 2, ptr, len);
	JSValue ab = JS_NewArrayBufferCopy(ctx, buf, total);
	skynet_free(buf);
	if (cstr) JS_FreeCString(ctx, cstr);
	return ab;
}

static void
np_clear(struct snjs *l) {
	struct np_queue *q = l->netpack_q;
	if (q == NULL)
		return;
	int i;
	for (i = 0; i < HASHSIZE; i++) {
		struct np_uncomplete *uc = q->hash[i];
		while (uc) {
			skynet_free(uc->pack.buffer);
			struct np_uncomplete *tmp = uc;
			uc = uc->next;
			skynet_free(tmp);
		}
		q->hash[i] = NULL;
	}
	if (q->head > q->tail)
		q->tail += q->cap;
	for (i = q->head; i < q->tail; i++) {
		skynet_free(q->queue[i % q->cap].buffer);
	}
	q->head = q->tail = 0;
}

// netpack.clear(): drop every queued packet and uncomplete reassembly buffer.
JSValue
js_netpack_clear(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
	struct snjs *l = JS_GetContextOpaque(ctx);
	(void)this_val; (void)argc; (void)argv;
	np_clear(l);
	return JS_UNDEFINED;
}

void
register_net_bridge(JSContext *ctx, JSValue obj) {
	JSValue net = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, net, "listen", JS_NewCFunction(ctx, js_sock_listen, "listen", 3));
	JS_SetPropertyStr(ctx, net, "connect", JS_NewCFunction(ctx, js_sock_connect, "connect", 2));
	JS_SetPropertyStr(ctx, net, "start", JS_NewCFunction(ctx, js_sock_start, "start", 1));
	JS_SetPropertyStr(ctx, net, "send", JS_NewCFunction(ctx, js_sock_send, "send", 2));
	JS_SetPropertyStr(ctx, net, "close", JS_NewCFunction(ctx, js_sock_close, "close", 1));
	JS_SetPropertyStr(ctx, net, "shutdown", JS_NewCFunction(ctx, js_sock_shutdown, "shutdown", 1));
	JS_SetPropertyStr(ctx, net, "nodelay", JS_NewCFunction(ctx, js_sock_nodelay, "nodelay", 1));
	JS_SetPropertyStr(ctx, net, "netpackMode", JS_NewCFunction(ctx, js_sock_netpack_mode, "netpackMode", 0));
	JS_SetPropertyStr(ctx, obj, "socket", JS_DupValue(ctx, net));
	JS_SetPropertyStr(ctx, obj, "net", net);

	JSValue netpack = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, netpack, "pop", JS_NewCFunction(ctx, js_netpack_pop, "pop", 0));
	JS_SetPropertyStr(ctx, netpack, "pack", JS_NewCFunction(ctx, js_netpack_pack, "pack", 1));
	JS_SetPropertyStr(ctx, netpack, "clear", JS_NewCFunction(ctx, js_netpack_clear, "clear", 0));
	JS_SetPropertyStr(ctx, obj, "netpack", netpack);
}


// service teardown: clear then free the queue itself (snjs_release).
void
js_netpack_free(struct snjs *l) {
	np_clear(l);
	if (l->netpack_q) {
		skynet_free(l->netpack_q);
		l->netpack_q = NULL;
	}
}
