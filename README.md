# SkyJS — 纯 C 内核 Skynet + QuickJS 运行时

SkyJS 将 [Skynet](https://github.com/cloudwu/skynet)(作为 git submodule 挂载于 `3rd/skynet/`,**源码零修改**)
与 QuickJS(quickjs-ng)结合,构建一个支持原生 C 服务与 JavaScript/TypeScript 服务的
Actor 模型服务端框架。

## 架构

```text
skyjs/                      # 顶层项目(git 主仓库,运行时 CWD;顶层均为本项目源码)
├── Makefile
├── platform/               # 内核替代层
│   ├── env.c               # 纯 C 替代 skynet_env.c(稳定指针语义)
│   ├── main.c              # 替代 skynet_main.c(JSON config)
│   └── lauxlib.h/.c        # malloc_hook.c 的 Lua stub(dump_mem_lua 永不调用)
├── service-src/
│   ├── snjs.c              # QuickJS 服务加载器(quickjs 静态编入,仅导出 snjs_* 四符号)
│   ├── js-seri.c           # lua-seri 二进制格式兼容层(与原版字节对拍通过)
│   ├── js-net.c            # skynetcore.net + gate 2 字节帧缓冲(per-fd 重组 + 队列)
│   └── skyclusterd.c       # cluster 重写(线协议兼容原版 lua-cluster.c)
├── cservice/               # 编译产物(logger.so/snjs.so/skyclusterd.so)
├── js/                     # JS 库:skynet.js/socket.js/builtins/skyjs/cluster.js/builtins/skyjs/gateserver.js
│                           # skyjs.d.ts = 全局注入面的 TS 类型声明(与库同源)
├── examples/               # TypeScript 接入示例(ts-echo:esbuild 转译 + 运行配置)
├── service/                # JS 服务脚本(bootstrap 等)
├── test/                   # 验收脚本与配置;seri-tool.c 为 lua-seri 对拍工具
├── docs/                   # 项目文档(开发手册/遗留事项/历史档案/性能基线)
└── 3rd/                    # [submodule] 外部依赖(全部零修改)
    ├── skynet/             # skynet 源码(skynet-src 15/17 文件零修改编译)
    └── quickjs/            # quickjs-ng(静态编入 snjs.so)
```

关键机制(均与 snlua 逐项对齐):

| skynet 机制 | snjs 对应 |
|---|---|
| `lua_newstate(lalloc)` 内存统计/限额 | `JS_NewRuntime2(js_mf, l)` 头部记账分配器 + `jsMemLimit` 配置 |
| `lua_sethook` 死循环打断 | `JS_SetInterruptHandler` + `SIGNAL` 命令(实测 2 秒内打断)；pending job 之间也检查 trap，microtask 链失控同样可打断 |
| 协程 session↔coroutine | session↔Promise(skynet.js `pendingCalls`),await = yield |
| 每消息 worker 线程归还 | dispatch 后 `JS_ExecutePendingJob` 排空(所有 await 挂在外部事件上)；SIGNAL 命中失控链则退出该服务 |
| lua-seri 消息(PTYPE_LUA) | js-seri.c 字节级兼容(int64→BigInt,table→Map) |

## 构建

```sh
git submodule update --init    # skynet + quickjs-ng(两个 submodule)
make                           # 产出 ./skyjs 主程序 + cservice/*.so + test 服务
make test/seri-tool            # lua-seri 参考对拍工具(链接 3rd/skynet/3rd/lua 的原版 Lua 源码)
make test                      # 自动化验收套件：12 场景日志断言 + 崩溃检测，
                               # 默认跑 2 轮抓偶发问题(node tools/run-tests.js，--repeat/--filter 可调)
make interop                   # 一键互通验收：构建原版 skynet submodule、双节点启动、
                               # 双向 cluster.call/query 断言(node tools/run-interop.js)
make longrun                   # 30 分钟长跑稳定性 + memstat/RSS 对账(DURATION=N 可调)
examples/ts-echo/build.sh      # TypeScript 示例转译(esbuild 仅构建期工具，运行时零依赖)
./skyjs examples/ts-echo/config.json   # 运行 TS 示例(预期输出 TS_ECHO_OK)
```

### 构建开关

| 开关 | 作用 | 说明 |
|---|---|---|
| `STATIC=1` | 静态内置 cservice | 把 `logger`/`snjs`/`skyclusterd` 三个生产模块链进 `skyjs`,不再产出对应 `.so`,得到单可执行文件。**保留 dlopen fallback**:测试服务与第三方 `.so` 仍按 `cpath` 动态加载。不支持 MinGW。 |
| `RELEASE=1` | 缩小产物 | `-Os` + section GC + strip + 去 `.eh_frame`(`-fno-*-unwind-tables`)。`skyjs` 由 ~5.7MB 降至 ~856KB。 |
| `TLS=openssl` | 启用 TLS/HTTPS/WSS | 链接系统 OpenSSL(动态)。 |

```sh
make STATIC=1 RELEASE=1                 # 又小又静态的单文件(~856KB)
make STATIC=1 RELEASE=1 TLS=openssl     # 叠加 TLS(约 870KB,动态链 libssl/libcrypto)
```

原理:cservice 走 skynet 原版 `dlopen(cpath)`+`dlsym("<name>_create")` 加载(`3rd/skynet` 零修改)。`STATIC=1` 仅在链接层 wrap `dlopen`(`platform/builtin-dl.c`):命中内置模块名时返回 `dlopen(NULL)`(主程序自身),入口符号随 `-rdynamic`/`-export_dynamic` 导出,原版 `dlsym` 原样命中;其余路径走真实 `dlopen`。扩展内置清单只需改 `builtin[]` 数组。

体积大头是 QuickJS 解释器本体(~578KB `.text`),基本不可再削(除非编译期裁剪 JS 特性,风险高)。LTO 实测无益(quickjs 符号几乎全被引用)。若还想更小,可选 `upx -9 ./skyjs` 压到 ~390KB——代价是启动时自解压(毫秒级)、个别安全软件可能误报,按需自取,未集成进构建。

三平台已验证:

| 平台 | 架构 | 构建命令 | 备注 |
|---|---|---|---|
| macOS | arm64 / x86_64 | `make` | 主开发平台 |
| Linux | x86_64 / aarch64 | `make` | `-lrt --shared` |
| Windows | x86_64 (MinGW-w64) | `make` | 需 MSYS2/MinGW-w64 环境(安装 `mingw-w64-x86_64-gcc` 与 `make`) |

CI 通过 GitHub Actions 矩阵在三平台上自动构建与 lint(`.github/workflows/build.yml`);
Windows 测试套件暂未启用(依赖 POSIX 信号等工具链)。
先 `NOUSE_JEMALLOC`(系统 malloc + per-service memstat),jemalloc 可后切。

## 运行

```sh
./skyjs test/config-core.json        # config 为扁平 JSON,全部键写入 env;
                                # 其中 thread/cpath/harbor/bootstrap/daemon/
                                # logger/logservice/profile 映射 skynet_config
```

JS 服务脚本约定(加载顺序:js/skynet.js → js/socket.js → js/builtins/skyjs/cluster.js → js/builtins/skyjs/gateserver.js → 用户脚本):

```js
skynet.start(() => {
    skynet.dispatch("text", async (msg, source, session) => {
        const r = await skynet.call(targetHandle, "text", "ping");
        return "reply:" + r;                 // 返回值自动回给调用方
    });
});
```

## 验收状态(全部通过)

| 场景 | 命令 | 验证点 |
|---|---|---|
| 纯 C 内核 | `./skyjs test/config-core.json` | logger + C echo bootstrap + SIGINT |
| JS echo/打断/OOM | `test/config-echo.json` 等 3 个 | JS↔C 互 call、SIGNAL 打断死循环(含纯 microtask 链)、memlimit OOM 可捕获 |
| console 面 | `test/config-console.json`(套件 console) | 各级别映射 skynet 日志；Map/BigInt/ArrayBuffer 递归渲染；printf 格式化(%s/%d/%f/%j/%o/%%)；time/timeLog/timeEnd |
| 异步核心 | `test/config-async.json` | 链式 await、10 并发挂起、重入与双 session 响应隔离、PTYPE_ERROR 传播 |
| socket 桥 | `test/config-socket.json` | JS TCP echo server + 客户端 + nc 外部互通；per-connection binary 以 ArrayBuffer 交付 |
| gate/redirect | `test/config-gate.json` | C netpack 分帧重组、watchdog→agent 绑定、PTYPE_CLIENT redirect、二进制/粘包/拆包回显 |
| lua-seri 对拍 | `test/seri-tool gen build/seri-ref.bin` + `test/config-seri.json` | 字节级 roundtrip、BigInt、Map、PTYPE_LUA 服务间互通 |
| cluster 双节点 | `test/config-cluster-a.json` + `config-cluster-b.json` | SkyJS↔SkyJS 跨节点 call；自动化版为 `config-cluster.json`(无 Lua 节点依赖) |
| cluster 重连语义 | `test/config-cluster-fail.json` | 对端宕机→call 立即失败(无后台重试)；对端上线→下一次 call 按需重连成功 |
| TypeScript 示例 | `examples/ts-echo/build.sh` + `./skyjs examples/ts-echo/config.json` | TS 服务转译加载、text/lua 协议 RTT、table→Map 往返(TS_ECHO_OK) |
| **与原版互通** | `make interop`(一键自动化);手动:`cd 3rd/skynet && make && ./skynet ../../test/cluster-lua/config` + `./skyjs test/config-cluster-interop.json` | SkyJS↔原版 Lua 节点双向 cluster.call/query |
| 基准 | `make bench`(一键,三阶段);单场景旧版:`test/config-bench.json` | 对比原版 skynet 的完整性能基线(核心消息/cluster/socket,方法学与数据见 [docs/bench.md](docs/bench.md)) |

## 与原版 Skynet 的差异

- 无 snlua/launcher/debug_console/harbor(master-slave);cluster 重写为
  `skyclusterd`(单服务状态机,合并 clusterd/agent/sender,直听 socket 免 gate),
  **线协议与原版逐字节兼容**(混合字节序:帧长大端/字段小端,9 种请求帧,
  MULTI_PART=0x8000 分片,addr==0 名字查询,session 超 INT32_MAX 回绕)
- cluster 未实现:clusterproxy、cluster.snax、与 gate 复用(harbor 的 master-slave 多节点同样不在范围内)
- 配置文件为 JSON(原版是 Lua 语法);所有键仍写入 env,服务可 GETENV 读取
- 热更新(inject)、sharetable、snax 无对应物;调试以日志 + SIGNAL 打断为主

## Submodule 管理

skyjs 是独立主工程(git 主仓库),含两个 submodule,统一放在 `3rd/`,URL 均指
向上游 GitHub:`3rd/skynet/`(cloudwu/skynet,源码零修改,固定于已验证的
commit)与 `3rd/quickjs/`(quickjs-ng,shallow 添加)。skynet 上游更新后仅需
重跑 `make` 并关注 `skynet_main.c/skynet_env.c` 的替代实现是否需要同步(两者
API 面极小且历史上极少变动)。与原版的互通验收需要原版可执行文件,用
submodule 自身的构建树生成(`cd 3rd/skynet && make`,产物为未跟踪文件,
不影响“零修改”承诺);对应配置在 `test/cluster-lua/`。

## 文档

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 开发手册(编码规范全文、C/JS 边界、验收与排查入口)
- [docs/TODO.md](docs/TODO.md) — 遗留事项与已知限制
- [docs/HISTORY.md](docs/HISTORY.md) — 历史演进与问题归因档案(已完成事项/修复记录)
- [docs/bench.md](docs/bench.md) — 性能对比基线(方法学与最新数据)
- 与原版 Skynet 的互通验证:一键 `make interop`(构建 submodule + 双节点
  启动 + 双向断言,见 tools/run-interop.js);原版 Lua 节点由 submodule 自身
  的构建产物启动(CWD = 3rd/skynet),配置与脚本在本项目 `test/cluster-lua/`
