#include "skynet.h"

#include "skynet_imp.h"
#include "skynet_env.h"
#include "skynet_server.h"

#include "quickjs.h"

int skyjs_runtime_get_exit_code(void);

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#ifndef _WIN32
#include <signal.h>
#endif
#include <assert.h>

#ifndef SKYNET_MAXTHREAD
#define SKYNET_MAXTHREAD 1024
#endif

/*
 * Pure-C replacement for skynet-src/skynet_main.c.
 *
 * The original boots a throwaway Lua VM to execute the config file (which
 * is Lua code, supporting $VAR substitution and `include`). skyjs configs
 * are flat JSON instead. Everything else is a faithful port of the
 * original main(): env defaults, skynet_start(), clean exit.
 */

static int
optint(const char *key, int opt) {
	const char * str = skynet_getenv(key);
	if (str == NULL) {
		char tmp[20];
		snprintf(tmp, sizeof(tmp), "%d", opt);
		skynet_setenv(key, tmp);
		return opt;
	}
	return strtol(str, NULL, 10);
}

static int
optboolean(const char *key, int opt) {
	const char * str = skynet_getenv(key);
	if (str == NULL) {
		skynet_setenv(key, opt ? "true" : "false");
		return opt;
	}
	return strcmp(str,"true")==0;
}

static const char *
optstring(const char *key,const char * opt) {
	const char * str = skynet_getenv(key);
	if (str == NULL) {
		if (opt) {
			skynet_setenv(key, opt);
			opt = skynet_getenv(key);
		}
		return opt;
	}
	return str;
}

#ifndef _WIN32
static int
sigign(void) {
	struct sigaction sa;
	sa.sa_handler = SIG_IGN;
	sa.sa_flags = 0;
	sigemptyset(&sa.sa_mask);
	sigaction(SIGPIPE, &sa, 0);
	return 0;
}
#endif

/* ---------------------------------------------------------- JSON config via QuickJS */

static int
parse_config(const char *json) {
	JSRuntime *rt = JS_NewRuntime();
	if (rt == NULL) {
		fprintf(stderr, "Failed to create JS runtime for config parsing\n");
		return 1;
	}
	JSContext *ctx = JS_NewContext(rt);
	if (ctx == NULL) {
		JS_FreeRuntime(rt);
		fprintf(stderr, "Failed to create JS context for config parsing\n");
		return 1;
	}
	JSValue obj = JS_ParseJSON(ctx, json, strlen(json), "<config>");
	if (JS_IsException(obj)) {
		fprintf(stderr, "Invalid config: JSON parse error\n");
		JS_FreeContext(ctx);
		JS_FreeRuntime(rt);
		return 1;
	}

	/* store the raw JSON text so JS services can parse it with full types */
	skynet_setenv("__json_config", json);

	/* walk top-level keys; primitive values go into the flat env store
	   (C consumers read thread/harbor/etc. as strings).  Objects and
	   arrays are skipped — they live only in __json_config for JS. */
	JSPropertyEnum *tab = NULL;
	uint32_t len = 0;
	if (JS_GetOwnPropertyNames(ctx, &tab, &len, obj,
			JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
		for (uint32_t i = 0; i < len; i++) {
			JSValue val = JS_GetProperty(ctx, obj, tab[i].atom);
			if (JS_IsNull(val) || JS_IsUndefined(val) || JS_IsObject(val)) {
				JS_FreeValue(ctx, val);
				continue;
			}
			const char *key = JS_AtomToCString(ctx, tab[i].atom);
			const char *str = JS_ToCString(ctx, val);
			if (key && str)
				skynet_setenv(key, str);
			if (str) JS_FreeCString(ctx, str);
			if (key) JS_FreeCString(ctx, key);
			JS_FreeValue(ctx, val);
		}
		for (uint32_t i = 0; i < len; i++)
			JS_FreeAtom(ctx, tab[i].atom);
		js_free(ctx, tab);
	}

	JS_FreeValue(ctx, obj);
	JS_FreeContext(ctx);
	JS_FreeRuntime(rt);
	return 0;
}

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

int
main(int argc, char *argv[]) {
	const char * config_file = NULL;
	if (argc > 1) {
		config_file = argv[1];
	} else {
		fprintf(stderr, "Need a config file.\n"
			"usage: skyjs configfilename\n");
		return 1;
	}

	skynet_globalinit();
	skynet_env_init();

#ifndef _WIN32
	sigign();
#endif

	char * json = read_file(config_file);
	if (json == NULL) {
		fprintf(stderr, "Can't open config file %s\n", config_file);
		return 1;
	}
	int err = parse_config(json);
	skynet_free(json);
	if (err) {
		return 1;
	}

	struct skynet_config config;

	config.thread =  optint("thread",8);
	if (config.thread < 1 || config.thread > SKYNET_MAXTHREAD) {
		fprintf(stderr, "Invalid thread %d , should be in [1,%d]\n", config.thread, SKYNET_MAXTHREAD);
		return 1;
	}
	config.module_path = optstring("cpath","./cservice/?.so");
	// SkyJS 不实现 harbor(master-slave) 多节点，固定为单节点模式
	config.harbor  = 0;
	config.bootstrap = optstring("bootstrap","snjs service/bootstrap.js");
	config.daemon = optstring("daemon", NULL);
	config.logger = optstring("logger", NULL);
	config.logservice = optstring("logservice", "logger");
	config.profile = optboolean("profile", 1);

	skynet_start(&config);
	skynet_globalexit();

	return skyjs_runtime_get_exit_code();
}
