UNAME_S := $(shell uname)

CC ?= cc
AR ?= ar

# RELEASE=1 shrinks the artifact: drop -g, optimise for size, and let the
# linker garbage-collect unused sections + strip symbols (see the link rule
# below for the platform-specific -Wl flags).  Default build keeps -g -O2.
ifeq ($(RELEASE),1)
  # -Os + section GC (link rule) trims code; -fno-*-unwind-tables drops the
  # ~115KB .eh_frame that C-only code never needs (skynet's deadloop trap uses
  # setjmp/longjmp, not stack unwinding); -fno-ident drops the .comment tag.
  # (LTO was measured to *not* help here — quickjs symbols are nearly all live.)
  CFLAGS ?= -Os -Wall -fstack-protector-strong -Wformat -Wformat-security \
    -ffunction-sections -fdata-sections \
    -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident
else
  CFLAGS ?= -g -O2 -Wall -fstack-protector-strong -Wformat -Wformat-security
endif

COMPAT_MINGW_DIR := 3rd/skynet/3rd/compat-mingw

# PLAT selects the target: macosx / linux / mingw.  Normally auto-detected from
# the host, but it can be forced explicitly to cross-compile, e.g. from macOS:
#   make PLAT=mingw CC=x86_64-w64-mingw32-gcc AR=x86_64-w64-mingw32-ar
ifeq ($(PLAT),)
  ifeq ($(UNAME_S),Darwin)
    PLAT := macosx
  else ifeq ($(OS),Windows_NT)
    PLAT := mingw
  else
    PLAT := linux
  endif
endif

ifeq ($(PLAT),macosx)
  SHARED := -fPIC -dynamiclib -Wl,-undefined,dynamic_lookup
  LIBS := -lpthread -lm -ldl
  EXE_SUFFIX :=
  COMPAT_FLAGS :=

else ifeq ($(PLAT),mingw)
  # Windows/MinGW — reuse skynet's compat-mingw layer
  # --export-all-symbols is required: skynet cservice plugins (loaded via dlopen)
  # need access to skynet_* API functions from the main executable.
  SHARED := -fPIC --shared -Wl,--export-all-symbols,--enable-auto-import
  LIBS := -static-libgcc -lpthread -lm -lws2_32 -lgdi32
  EXE_SUFFIX := .exe
  COMPAT_FLAGS := -I$(COMPAT_MINGW_DIR) -include $(COMPAT_MINGW_DIR)/compat.h
  CFLAGS += $(COMPAT_FLAGS)
  CFLAGS += -Wno-int-conversion -Wno-incompatible-pointer-types -Wno-pointer-sign

else
  # Linux
  SHARED := -fPIC --shared
  LIBS := -lpthread -lm -ldl -lrt
  EXE_SUFFIX :=
  COMPAT_FLAGS :=
endif

# Windows DLLs must resolve every symbol at link time (unlike Linux/macOS shared
# objects).  skyjs.exe exports its symbols and emits an import library as a side
# effect of linking; each cservice DLL then links against that import library so
# the skynet_* callbacks resolve as imports from skyjs.exe.  Defined here (before
# any rule uses it) because prerequisite lists are expanded at parse time.
ifeq ($(PLAT),mingw)
  IMPORT_LIB := build/libskyjs.a
  EXPORT_DYNAMIC := -Wl,--export-all-symbols,--out-implib,$(IMPORT_LIB)
else ifeq ($(PLAT),linux)
  IMPORT_LIB :=
  EXPORT_DYNAMIC := -rdynamic
else
  IMPORT_LIB :=
  EXPORT_DYNAMIC :=
endif

# NOUSE_JEMALLOC: system malloc, per-service memstat still active (malloc_hook.c)
SKYNET_DEFINES := -DNOUSE_JEMALLOC

# Optional OpenSSL / TLS support: make TLS=openssl
OPENSSL_CFLAGS :=
OPENSSL_LDFLAGS :=
TLS_OBJ :=
ifeq ($(TLS),openssl)
  ifeq ($(PLAT),macosx)
    OPENSSL_INC ?= /opt/homebrew/opt/openssl/include
    OPENSSL_LIB ?= /opt/homebrew/opt/openssl/lib
  else
    # Linux / others: system default paths (apt: libssl-dev puts headers in
    # /usr/include/openssl, libs in /usr/lib/...).  Override via env or CLI
    # if needed, e.g. OPENSSL_INC=/usr/local/include make TLS=openssl
    OPENSSL_INC ?=
    OPENSSL_LIB ?=
  endif
  OPENSSL_CFLAGS := $(if $(OPENSSL_INC),-I$(OPENSSL_INC)) -DUSE_OPENSSL
  OPENSSL_LDFLAGS := $(if $(OPENSSL_LIB),-L$(OPENSSL_LIB)) -lssl -lcrypto
  TLS_OBJ := build/tls.o
endif

SKYNET_INC := 3rd/skynet/skynet-src

# qjsc is a build-time codegen tool: it must run on the build HOST, not the
# target.  Native builds (incl. MSYS2, where CC is already the mingw gcc) build
# it with CC as before.  When cross-compiling to mingw from a non-Windows host,
# build it (and the quickjs objects it needs) with HOST_CC instead so it can
# actually run.
HOST_CC ?= cc
ifeq ($(PLAT),mingw)
  ifneq ($(OS),Windows_NT)
    CROSS := 1
  endif
endif

# 15 of the 17 original SKYNET_SRC files; skynet_main.c and skynet_env.c are
# replaced by platform/main.c and platform/env.c (skynet sources untouched).
SKYNET_SRC := skynet_handle.c skynet_module.c skynet_mq.c skynet_server.c \
  skynet_start.c skynet_timer.c skynet_error.c skynet_harbor.c skynet_monitor.c \
  skynet_socket.c socket_server.c mem_info.c malloc_hook.c skynet_daemon.c skynet_log.c

SKYNET_OBJ := $(addprefix build/skynet_,$(SKYNET_SRC:.c=.o))
PLATFORM_OBJ := build/env.o build/main.o build/lua-stub.o build/runtime-exit.o

# quickjs-ng core (linked into the main skyjs executable; .so modules resolve symbols at runtime)
QJS_SRC := 3rd/quickjs/quickjs.c 3rd/quickjs/libregexp.c 3rd/quickjs/libunicode.c 3rd/quickjs/dtoa.c
QJS_OBJ := $(addprefix build/qjs_,$(notdir $(QJS_SRC:.c=.o)))

TARGET := skyjs$(EXE_SUFFIX)
VERSION := $(shell sed -n 's/.*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -1)

# NC0.1 deterministic module manifest. The generator lists its dependencies so
# Make can regenerate the manifest before any new internal/builtin module is
# consumed by the future CJS loader.
MODULE_MANIFEST := build/module-manifest.json
MODULE_MANIFEST_DEPS := $(shell node tools/gen-module-manifest.js --list-files)

# STATIC=1: fold the production cservice modules into the skyjs executable
# instead of loading them as .so at runtime (see platform/builtin-dl.c).  The
# dlopen fallback stays intact, so test services and third-party plugins still
# load dynamically.  Not supported on MinGW (no dlopen / interpose).
BUILTIN_OBJ :=
STATIC_LDFLAGS :=
ifeq ($(STATIC),1)
  BUILTIN_OBJ := build/snjs.o build/seri.o build/net.o build/crypto.o \
    build/io.o build/runtime.o $(TLS_OBJ) build/rt_bc.o build/svc_logger.o \
    build/svc_skyclusterd.o build/builtin-dl.o
  ifeq ($(PLAT),macosx)
    STATIC_LDFLAGS := -Wl,-export_dynamic
  else ifeq ($(PLAT),linux)
    STATIC_LDFLAGS := -Wl,--wrap=dlopen
  endif
endif

# RELEASE=1: garbage-collect unused sections + strip the final binary.  The
# size flags (-Os / -ffunction-sections / -fdata-sections) are set with CFLAGS
# above; here we add the matching link-time flags.
RELEASE_LDFLAGS :=
ifeq ($(RELEASE),1)
  ifeq ($(PLAT),macosx)
    RELEASE_LDFLAGS := -Wl,-dead_strip
  else
    RELEASE_LDFLAGS := -Wl,--gc-sections -Wl,-s
  endif
endif

# STATIC folds logger/snjs/skyclusterd into skyjs, so those .so are not built;
# the test services stay dynamic and exercise the dlopen fallback.
ifeq ($(STATIC),1)
all: $(MODULE_MANIFEST) $(TARGET) test/cservice/echo.so test/cservice/driver.so
else
all: $(MODULE_MANIFEST) $(TARGET) cservice/logger.so cservice/snjs.so \
	cservice/skyclusterd.so test/cservice/echo.so test/cservice/driver.so
endif

$(MODULE_MANIFEST): tools/gen-module-manifest.js $(MODULE_MANIFEST_DEPS) | build
	node tools/gen-module-manifest.js --output $@

build:
	mkdir -p build
cservice:
	mkdir -p cservice
test/cservice:
	mkdir -p test/cservice

build/skynet_%.o: 3rd/skynet/skynet-src/%.c | build
	$(CC) $(CFLAGS) $(SKYNET_DEFINES) -I$(SKYNET_INC) -Iplatform -c $< -o $@

build/%.o: platform/%.c | build
	$(CC) $(CFLAGS) $(SKYNET_DEFINES) -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/qjs_%.o: 3rd/quickjs/%.c | build
	$(CC) $(CFLAGS) -fPIC -D_GNU_SOURCE -I3rd/quickjs -c $< -o $@

build/snjs.o: service-src/snjs.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC $(OPENSSL_CFLAGS) -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@ -DSKYJS_VERSION=\"$(VERSION)\"

build/seri.o: service-src/js-seri.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/net.o: service-src/js-net.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/crypto.o: service-src/js-crypto.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC $(OPENSSL_CFLAGS) -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/tls.o: service-src/js-tls.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC $(OPENSSL_CFLAGS) -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/io.o: service-src/js-io.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -c $< -o $@

build/runtime.o: service-src/js-runtime.c service-src/snjs-internal.h | build
	$(CC) $(CFLAGS) -fPIC -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -I3rd/quickjs -DSKYJS_VERSION=\"$(VERSION)\" -c $< -o $@

# STATIC-only object builds of logger + skyclusterd (same flags as their .so
# rules; distinct names avoid the build/skynet_%.o pattern that targets
# skynet-src/).  builtin-dl.o uses the generic platform/%.o rule.
# logger has no MODAPI visibility markers (unlike snjs/skyclusterd); its .so
# rule relies on default visibility, so we must NOT hide symbols here or the
# logger_* entry points won't reach skyjs's -rdynamic export table.
build/svc_logger.o: 3rd/skynet/service-src/service_logger.c | build
	$(CC) $(CFLAGS) -fPIC -I$(SKYNET_INC) -c $< -o $@

build/svc_skyclusterd.o: service-src/skyclusterd.c | build
	$(CC) $(CFLAGS) -fPIC -fvisibility=hidden -I$(SKYNET_INC) -Iplatform -c $< -o $@

# host compiler used to precompile the JS runtime libraries into bytecode
# (quickjs-libc provides the std helpers qjsc references).
# NOTE: kept below the `all` rule so plain `make` still builds everything.
ifdef CROSS
# Cross build: compile qjsc and its quickjs objects with the host toolchain so
# the generated tool runs on this machine (plain flags, no mingw compat layer).
QJSC_QJS_OBJ := $(addprefix build/hostqjs_,$(notdir $(QJS_SRC:.c=.o)))
build/hostqjs_%.o: 3rd/quickjs/%.c | build
	$(HOST_CC) -g -O2 -Wall -D_GNU_SOURCE -I3rd/quickjs -c $< -o $@
build/qjsc: 3rd/quickjs/qjsc.c 3rd/quickjs/quickjs-libc.c $(QJSC_QJS_OBJ) | build
	$(HOST_CC) -g -O2 -Wall -D_GNU_SOURCE -I3rd/quickjs -o $@ 3rd/quickjs/qjsc.c 3rd/quickjs/quickjs-libc.c $(QJSC_QJS_OBJ) -lm
else
build/qjsc: 3rd/quickjs/qjsc.c 3rd/quickjs/quickjs-libc.c $(QJS_OBJ) | build
	$(CC) $(CFLAGS) -D_GNU_SOURCE -I3rd/quickjs -o $@ 3rd/quickjs/qjsc.c 3rd/quickjs/quickjs-libc.c $(QJS_OBJ) -lm
endif

# embedded bytecode of js/skynet.js + js/socket.js + js/internal/crypt-core.js +
# js/sockethelper.js + skyjs/cluster.js + js/builtins/skyjs/gateserver.js + js/http.js +
# js/websocket.js + js/internal/fs-core.js + js/ioservice.js: snjs loads these instead of
# parsing the sources per service. Regenerated whenever the sources or the
# quickjs submodule move; never committed.
build/rt_bc.c: build/qjsc js/skynet.js js/socket.js js/internal/crypt-core.js js/sockethelper.js js/builtins/skyjs/cluster.js js/builtins/skyjs/gateserver.js js/http.js js/websocket.js js/internal/fs-core.js js/ioservice.js | build
	./build/qjsc -s -N snjs_bc_skynet -o build/bc_skynet.c js/skynet.js
	./build/qjsc -s -N snjs_bc_socket -o build/bc_socket.c js/socket.js
	./build/qjsc -s -N snjs_bc_crypt -o build/bc_crypt.c js/internal/crypt-core.js
	./build/qjsc -s -N snjs_bc_sockethelper -o build/bc_sockethelper.c js/sockethelper.js
	./build/qjsc -s -N snjs_bc_cluster -o build/bc_cluster.c js/builtins/skyjs/cluster.js
	./build/qjsc -s -N snjs_bc_gateserver -o build/bc_gateserver.c js/builtins/skyjs/gateserver.js
	./build/qjsc -s -N snjs_bc_http -o build/bc_http.c js/http.js
	./build/qjsc -s -N snjs_bc_websocket -o build/bc_websocket.c js/websocket.js
	./build/qjsc -s -N snjs_bc_io -o build/bc_io.c js/internal/fs-core.js
	./build/qjsc -s -N snjs_bc_ioservice -o build/bc_ioservice.c js/ioservice.js
	cat build/bc_skynet.c build/bc_socket.c build/bc_crypt.c build/bc_sockethelper.c build/bc_cluster.c build/bc_gateserver.c build/bc_http.c build/bc_websocket.c build/bc_io.c build/bc_ioservice.c > $@

build/rt_bc.o: build/rt_bc.c | build
	$(CC) $(CFLAGS) -fPIC -c $< -o $@

cservice/snjs.so: build/snjs.o build/seri.o build/net.o build/crypto.o \
	build/io.o build/runtime.o $(TLS_OBJ) build/rt_bc.o $(IMPORT_LIB) | cservice
	$(CC) $(CFLAGS) $(SHARED) -fvisibility=hidden -o $@ $^ $(OPENSSL_LDFLAGS) -lm

# reference tool: original lua-seri.c linked with the stock Lua 5.5.1 shipped
# in 3rd/skynet's 3rd/lua (byte-exact ground truth for the seri format).
# The layout is flat, same as how the stock skynet Makefile consumes it; exclude
# the interpreter entry points lua.c/luac.c and the all-in-one onelua.c.
LUA_SRC := $(filter-out 3rd/skynet/3rd/lua/lua.c 3rd/skynet/3rd/lua/luac.c 3rd/skynet/3rd/lua/onelua.c,$(wildcard 3rd/skynet/3rd/lua/*.c))

test/seri-tool: test/seri-tool.c 3rd/skynet/lualib-src/lua-seri.c $(LUA_SRC)
	$(CC) $(CFLAGS) -I3rd/skynet/skynet-src -I3rd/skynet/lualib-src -I3rd/skynet/3rd/lua -o $@ test/seri-tool.c $(LUA_SRC) -lm

ifeq ($(PLAT),mingw)
COMPAT_OBJ := build/compat.o
$(COMPAT_OBJ): platform/mingw-compat.c | build
	$(CC) $(CFLAGS) -c $< -o $@
else
COMPAT_OBJ :=
endif

$(TARGET): $(SKYNET_OBJ) $(PLATFORM_OBJ) $(COMPAT_OBJ) $(QJS_OBJ) $(BUILTIN_OBJ)
	$(CC) $(CFLAGS) $(EXPORT_DYNAMIC) $(STATIC_LDFLAGS) $(RELEASE_LDFLAGS) -o $@ $^ $(LIBS) $(OPENSSL_LDFLAGS)

# On MinGW the import library is produced together with skyjs.exe; declare the
# dependency so cservice DLLs are linked only after it exists.
ifeq ($(PLAT),mingw)
$(IMPORT_LIB): $(TARGET)
	@:
endif

cservice/logger.so: 3rd/skynet/service-src/service_logger.c $(IMPORT_LIB) | cservice
	$(CC) $(CFLAGS) $(SHARED) $< -o $@ -I$(SKYNET_INC) $(IMPORT_LIB)

test/cservice/%.so: test/service-src/%.c $(IMPORT_LIB) | test/cservice
	$(CC) $(CFLAGS) $(SHARED) $< -o $@ -I$(SKYNET_INC) $(IMPORT_LIB)

cservice/skyclusterd.so: service-src/skyclusterd.c $(IMPORT_LIB) | cservice
	$(CC) $(CFLAGS) $(SHARED) -fvisibility=hidden $< -o $@ -I$(SKYNET_INC) -Iplatform $(IMPORT_LIB)

clean:
	rm -rf build skyjs skyjs.exe test/seri-tool test/seri-tool.dSYM \
		cservice/*.so cservice/*.dSYM \
		test/cservice/*.so test/cservice/*.dSYM

# acceptance suite: builds everything first, then drives all scenarios
# (see tools/run-tests.js header for the pass/fail model); seri_tool is a
# separate target because `all` does not build it
test: all test/seri-tool
	node tools/gen-module-manifest.js --check
	node tools/run-tests.js

# one-command interop acceptance against the stock Lua skynet node:
# builds the 3rd/skynet submodule, boots both nodes, asserts both directions
interop: all
	node tools/run-interop.js

# benchmark suite: skyjs vs stock skynet, three phases (core + cluster +
# socket, methodology + baseline in docs/bench.md); override with e.g.
# make bench PHASE=core REPEAT=5
PHASE ?= all
REPEAT ?= 3
bench: all
	node tools/run-bench.js --phase $(PHASE) --repeat $(REPEAT)

# long-run soak with memstat/RSS reconciliation (tools/run-longrun.js);
# default 30 minutes, override with e.g. make longrun DURATION=5
DURATION ?= 30
longrun: all
	node tools/run-longrun.js --minutes $(DURATION)

# self-signed test certs for TLS acceptance (valid 10 years, localhost + 127.0.0.1)
test/certs/server.pem:
	mkdir -p test/certs
	openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
		-keyout test/certs/server.key -out test/certs/server.pem \
		-days 3650 -nodes -subj "/CN=localhost" \
		-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
	cp test/certs/server.pem test/certs/ca.pem

test-certs: test/certs/server.pem

.PHONY: all clean test interop bench longrun test-certs
