/*
 * js-subprocess.c -- child process primitives for SkyJS.
 *
 * Registered as the skynetcore.subprocess namespace. POSIX builds use
 * posix_spawn with explicit pipe fds; the primitives are synchronous and are
 * only ever called from the `.subprocess` owner service, which serializes
 * access and enforces quotas.
 *
 * Handle model: each process owns three optional pipe fds (stdin/stdout/
 * stderr) held in a per-service table. read() is non-blocking (O_NONBLOCK) and
 * returns "again" when no data is ready, "eof" at end of stream; the owner's
 * read loop drives it through skynet's socket/message pump.
 *
 * Excluded from mobile builds via SUBPROCESS=1 (see Makefile); without the
 * module, require('child_process') throws ERR_UNSUPPORTED_PLATFORM.
 */

#include "skynet.h"
#include "snjs-internal.h"

#include <quickjs.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if !defined(_WIN32)
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

#define MAX_PROC 64
#define MAX_FD 3

#if !defined(_WIN32)

struct sub_proc {
	int used;
	int pid;
	int fds[MAX_FD];       /* 0=stdin, 1=stdout, 2=stderr; -1 when ignored/closed */
	int exited;
	int code;
	int signal;
};

static struct sub_proc procs[MAX_PROC];

static void
subprocess_reset_tables(void) {
	for (int i = 0; i < MAX_PROC; i++) {
		for (int k = 0; k < MAX_FD; k++) procs[i].fds[k] = -1;
	}
}

__attribute__((constructor))
static void
subprocess_init_tables(void) {
	subprocess_reset_tables();
}

static struct sub_proc *
find_proc(int pid) {
	for (int i = 0; i < MAX_PROC; i++) {
		if (procs[i].used && procs[i].pid == pid) return &procs[i];
	}
	return NULL;
}

static struct sub_proc *
find_fd(int fd, int *which) {
	for (int i = 0; i < MAX_PROC; i++) {
		if (!procs[i].used) continue;
		for (int k = 0; k < MAX_FD; k++) {
			if (procs[i].fds[k] == fd) {
				if (which) *which = k;
				return &procs[i];
			}
		}
	}
	return NULL;
}

static void
set_nonblock(int fd) {
	int flags = fcntl(fd, F_GETFL, 0);
	if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

static void
close_proc_fds(struct sub_proc *p) {
	for (int k = 0; k < MAX_FD; k++) {
		if (p->fds[k] >= 0) {
			close(p->fds[k]);
			p->fds[k] = -1;
		}
	}
}

static void
reap(struct sub_proc *p) {
	if (p->exited) return;
	int status = 0;
	pid_t r = waitpid(p->pid, &status, WNOHANG);
	if (r == p->pid) {
		p->exited = 1;
		if (WIFEXITED(status)) p->code = WEXITSTATUS(status);
		else p->code = -1;
		p->signal = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
	}
}

/* subprocess.spawn(program, argsArray, opts) -> { pid, stdinFd, stdoutFd, stderrFd } */
static JSValue
js_sub_spawn(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	if (argc < 1) return JS_ThrowTypeError(ctx, "subprocess.spawn(program, args, opts)");

	const char *program = JS_ToCString(ctx, argv[0]);
	if (!program) return JS_EXCEPTION;

	/* Build the argv vector. */
	int arg_count = 1;
	int arg_cap = 16;
	char **args = skynet_malloc(sizeof(char *) * arg_cap);
	if (!args) { JS_FreeCString(ctx, program); return JS_EXCEPTION; }
	args[0] = (char *)program;
	arg_count = 1;

	if (argc > 1 && JS_IsArray(argv[1])) {
		JSValue lenv = JS_GetPropertyStr(ctx, argv[1], "length");
		int32_t len = 0;
		JS_ToInt32(ctx, &len, lenv);
		JS_FreeValue(ctx, lenv);
		for (int32_t i = 0; i < len; i++) {
			JSValue item = JS_GetPropertyUint32(ctx, argv[1], (uint32_t)i);
			const char *s = JS_ToCString(ctx, item);
			JS_FreeValue(ctx, item);
			if (!s) continue;
			if (arg_count + 2 >= arg_cap) {
				arg_cap *= 2;
				char **grown = skynet_malloc(sizeof(char *) * arg_cap);
				memcpy(grown, args, sizeof(char *) * arg_count);
				skynet_free(args);
				args = grown;
			}
			args[arg_count++] = (char *)s;
		}
	}
	args[arg_count] = NULL;

	/* stdin/stdout/stderr are pipes (the only mode the owner needs). */
	int in_pipe[2] = { -1, -1 };
	int out_pipe[2] = { -1, -1 };
	int err_pipe[2] = { -1, -1 };
	if (pipe(in_pipe) != 0 || pipe(out_pipe) != 0 || pipe(err_pipe) != 0) {
		JS_FreeCString(ctx, program);
		return JS_ThrowInternalError(ctx, "subprocess.spawn: pipe() failed");
	}

	posix_spawn_file_actions_t actions;
	posix_spawn_file_actions_init(&actions);
	posix_spawn_file_actions_adddup2(&actions, in_pipe[0], STDIN_FILENO);
	posix_spawn_file_actions_adddup2(&actions, out_pipe[1], STDOUT_FILENO);
	posix_spawn_file_actions_adddup2(&actions, err_pipe[1], STDERR_FILENO);
	posix_spawn_file_actions_addclose(&actions, in_pipe[1]);
	posix_spawn_file_actions_addclose(&actions, out_pipe[0]);
	posix_spawn_file_actions_addclose(&actions, err_pipe[0]);

	pid_t pid = -1;
	int rc = posix_spawnp(&pid, program, &actions, NULL, args, environ);
	posix_spawn_file_actions_destroy(&actions);

	/* Parent closes the child's ends. */
	close(in_pipe[0]);
	close(out_pipe[1]);
	close(err_pipe[1]);

	if (rc != 0) {
		close(in_pipe[1]);
		close(out_pipe[0]);
		close(err_pipe[0]);
		JS_FreeCString(ctx, program);
		return JS_ThrowInternalError(ctx,
			"subprocess.spawn: %s: %s", program, strerror(rc));
	}

	struct sub_proc *p = NULL;
	for (int i = 0; i < MAX_PROC; i++) {
		if (!procs[i].used) { p = &procs[i]; break; }
	}
	if (p == NULL) {
		kill(pid, SIGKILL);
		close(in_pipe[1]); close(out_pipe[0]); close(err_pipe[0]);
		JS_FreeCString(ctx, program);
		return JS_ThrowInternalError(ctx, "subprocess.spawn: process table full");
	}
	p->used = 1;
	p->pid = pid;
	p->fds[0] = in_pipe[1];
	p->fds[1] = out_pipe[0];
	p->fds[2] = err_pipe[0];
	p->exited = 0;
	p->code = 0;
	p->signal = 0;
	set_nonblock(p->fds[1]);
	set_nonblock(p->fds[2]);

	JSValue ret = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, ret, "pid", JS_NewInt32(ctx, pid));
	JS_SetPropertyStr(ctx, ret, "stdinFd", JS_NewInt32(ctx, p->fds[0]));
	JS_SetPropertyStr(ctx, ret, "stdoutFd", JS_NewInt32(ctx, p->fds[1]));
	JS_SetPropertyStr(ctx, ret, "stderrFd", JS_NewInt32(ctx, p->fds[2]));

	for (int i = 1; i < arg_count; i++) JS_FreeCString(ctx, args[i]);
	skynet_free(args);
	JS_FreeCString(ctx, program);
	return ret;
}

/* subprocess.wait(pid) -> { exited, code, signal } (non-blocking) */
static JSValue
js_sub_wait(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t pid = 0;
	if (JS_ToInt32(ctx, &pid, argv[0])) return JS_EXCEPTION;
	struct sub_proc *p = find_proc(pid);
	if (p == NULL) return JS_ThrowTypeError(ctx, "subprocess.wait: unknown pid");
	reap(p);
	JSValue ret = JS_NewObject(ctx);
	JS_SetPropertyStr(ctx, ret, "exited", JS_NewBool(ctx, p->exited));
	JS_SetPropertyStr(ctx, ret, "code", JS_NewInt32(ctx, p->code));
	JS_SetPropertyStr(ctx, ret, "signal", JS_NewInt32(ctx, p->signal));
	return ret;
}

/* subprocess.kill(pid, sig) -> boolean */
static JSValue
js_sub_kill(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t pid = 0;
	int32_t sig = SIGTERM;
	if (JS_ToInt32(ctx, &pid, argv[0])) return JS_EXCEPTION;
	if (argc > 1 && !JS_IsUndefined(argv[1])) {
		if (JS_ToInt32(ctx, &sig, argv[1])) return JS_EXCEPTION;
	}
	struct sub_proc *p = find_proc(pid);
	if (p == NULL) return JS_ThrowTypeError(ctx, "subprocess.kill: unknown pid");
	/* TERM first, then KILL if still alive (the owner escalates on timeout). */
	if (kill(pid, sig) != 0 && errno != ESRCH) {
		return JS_NewBool(ctx, 0);
	}
	return JS_NewBool(ctx, 1);
}

/* subprocess.read(fd, maxBytes) -> ArrayBuffer | "again" | "eof" */
static JSValue
js_sub_read(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t fd = 0, max = 65536;
	if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
	if (argc > 1 && !JS_IsUndefined(argv[1])) {
		if (JS_ToInt32(ctx, &max, argv[1])) return JS_EXCEPTION;
	}
	if (max <= 0 || max > 16 * 1024 * 1024) max = 65536;
	if (find_fd(fd, NULL) == NULL) return JS_ThrowTypeError(ctx, "subprocess.read: unknown fd");

	uint8_t *buf = skynet_malloc((size_t)max);
	if (!buf) return JS_EXCEPTION;
	ssize_t n = read(fd, buf, (size_t)max);
	if (n < 0) {
		skynet_free(buf);
		if (errno == EAGAIN || errno == EWOULDBLOCK) return JS_NewString(ctx, "again");
		return JS_ThrowInternalError(ctx, "subprocess.read: %s", strerror(errno));
	}
	if (n == 0) {
		skynet_free(buf);
		return JS_NewString(ctx, "eof");
	}
	JSValue ret = JS_NewArrayBufferCopy(ctx, buf, (size_t)n);
	skynet_free(buf);
	return ret;
}

/* subprocess.write(fd, ab) -> bytes written */
static JSValue
js_sub_write(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t fd = 0;
	if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
	if (find_fd(fd, NULL) == NULL) return JS_ThrowTypeError(ctx, "subprocess.write: unknown fd");
	size_t sz = 0;
	uint8_t *p = JS_GetArrayBuffer(ctx, &sz, argv[1]);
	if (!p) return JS_EXCEPTION;
	ssize_t n = write(fd, p, sz);
	if (n < 0) {
		if (errno == EAGAIN || errno == EWOULDBLOCK) return JS_NewInt32(ctx, 0);
		return JS_ThrowInternalError(ctx, "subprocess.write: %s", strerror(errno));
	}
	return JS_NewInt32(ctx, (int32_t)n);
}

/* subprocess.close(fd) -> undefined */
static JSValue
js_sub_close(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t fd = 0;
	if (JS_ToInt32(ctx, &fd, argv[0])) return JS_EXCEPTION;
	struct sub_proc *p = find_fd(fd, NULL);
	if (p == NULL) return JS_UNDEFINED;
	for (int k = 0; k < MAX_FD; k++) {
		if (p->fds[k] == fd) {
			close(fd);
			p->fds[k] = -1;
		}
	}
	return JS_UNDEFINED;
}

/* subprocess.release(pid) -> undefined (drop bookkeeping after wait) */
static JSValue
js_sub_release(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv;
	int32_t pid = 0;
	if (JS_ToInt32(ctx, &pid, argv[0])) return JS_EXCEPTION;
	struct sub_proc *p = find_proc(pid);
	if (p == NULL) return JS_UNDEFINED;
	reap(p);
	/* Only drop the slot once the child is reaped, so no zombie is left. */
	if (p->exited) {
		close_proc_fds(p);
		memset(p, 0, sizeof(*p));
		for (int k = 0; k < MAX_FD; k++) p->fds[k] = -1;
	} else {
		kill(p->pid, SIGKILL);
		waitpid(p->pid, NULL, 0);
		close_proc_fds(p);
		memset(p, 0, sizeof(*p));
		for (int k = 0; k < MAX_FD; k++) p->fds[k] = -1;
	}
	return JS_UNDEFINED;
}

/* subprocess.reapAll() -> number (service teardown: no orphans) */
static JSValue
js_sub_reap_all(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	int n = 0;
	for (int i = 0; i < MAX_PROC; i++) {
		struct sub_proc *p = &procs[i];
		if (!p->used) continue;
		if (!p->exited) {
			kill(p->pid, SIGKILL);
			waitpid(p->pid, NULL, 0);
		}
		close_proc_fds(p);
		memset(p, 0, sizeof(*p));
		for (int k = 0; k < MAX_FD; k++) p->fds[k] = -1;
		n++;
	}
	return JS_NewInt32(ctx, n);
}

#else /* _WIN32 */

static JSValue
js_sub_unsupported(JSContext *ctx, JSValueConst tv, int argc, JSValueConst *argv) {
	(void)tv; (void)argc; (void)argv;
	return JS_ThrowInternalError(ctx, "subprocess: not supported on this platform");
}

#endif /* _WIN32 */

void
register_subprocess_bridge(JSContext *ctx, JSValue obj) {
	JSValue sub = JS_NewObject(ctx);
#if !defined(_WIN32)
	JS_SetPropertyStr(ctx, sub, "spawn",
		JS_NewCFunction(ctx, js_sub_spawn, "spawn", 3));
	JS_SetPropertyStr(ctx, sub, "wait",
		JS_NewCFunction(ctx, js_sub_wait, "wait", 1));
	JS_SetPropertyStr(ctx, sub, "kill",
		JS_NewCFunction(ctx, js_sub_kill, "kill", 2));
	JS_SetPropertyStr(ctx, sub, "read",
		JS_NewCFunction(ctx, js_sub_read, "read", 2));
	JS_SetPropertyStr(ctx, sub, "write",
		JS_NewCFunction(ctx, js_sub_write, "write", 2));
	JS_SetPropertyStr(ctx, sub, "close",
		JS_NewCFunction(ctx, js_sub_close, "close", 1));
	JS_SetPropertyStr(ctx, sub, "release",
		JS_NewCFunction(ctx, js_sub_release, "release", 1));
	JS_SetPropertyStr(ctx, sub, "reapAll",
		JS_NewCFunction(ctx, js_sub_reap_all, "reapAll", 0));
	JS_SetPropertyStr(ctx, sub, "enabled", JS_NewBool(ctx, 1));
#else
	(void)js_sub_unsupported;
	JS_SetPropertyStr(ctx, sub, "enabled", JS_NewBool(ctx, 0));
#endif
	JS_SetPropertyStr(ctx, obj, "subprocess", sub);
}
