# SkyJS 开发手册

AGENTS.md 的详细版：编码规范全文、C/JS 边界、验收测试与排查入口。
遗留事项与已知限制见 [TODO.md](TODO.md)，历史演进与问题归因档案见
[HISTORY.md](HISTORY.md)，验收矩阵速览见根 [README.md](../README.md)，性能基线见 [bench.md](bench.md)。

> **文档口径总说明（现状／迁移前）**：本文描述的是**当前代码**的实现与命名——
> 扁平 `skynetcore.*`（`send`/`readFile`/`socket`/`pack` 混在顶层）与逐库加载键
> （`jsLoader`/`jsSocket`/`jsCluster`/`jsGateserver`）。目标架构改为按能力分组
> （`skynetcore.runtime`/`.fs`/`.net`/`.seri`/…）、CommonJS 单一 `require` 入口，加载键
> 收敛为 `jsBootstrap`/`jsModuleRoot`/`jsModuleSource`，见
> [node-compatibility.md](node-compatibility.md) §16.3–16.5 与
> [infra/01-conventions.md](infra/01-conventions.md) §2–3。目标设计以那两份为准；
> 重构落地前本文保持现状口径，全文出现的旧命名按"迁移前"理解。

## 验收测试

自动化验收:`make test`(tools/run-tests.js 逐行断言,覆盖全部场景);
互通双向断言一键化:`make interop`(tools/run-interop.js);改动后跑对应
场景,预期输出对照 `test/service/*.js` 中的标记。

| 场景 | 配置 | 验证点 |
|---|---|---|
| 纯 C 内核 | `test/config-core.json` | logger + C echo bootstrap |
| JS echo/打断/OOM | `test/config-echo.json`、`config-deadloop.json`、`config-oom.json` | JS↔C 互 call、SIGNAL 打断(同步死循环 + microtask 链)、memlimit |
| TypeScript 示例 | `./skyjs examples/ts-echo/config.json`(手动,不入套件) | TS 服务经 esbuild 转译后源码加载;text/lua 协议 RTT 与 table→LuaTable 往返断言(TS_ECHO_OK) |
| console 面 | `test/config-console.json`(套件 console) | 各级别映射日志；递归渲染；printf 格式化(%s/%d/%f/%j/%o/%%)；time/timeLog/timeEnd |
| 异步核心 | `test/config-async.json` | 链式 await、重入、双 session 响应隔离、并发挂起、PTYPE_ERROR |
| socket 桥 | `test/config-socket.json` | TCP echo + nc 互通；per-connection binary（ArrayBuffer） |
| gate/redirect | `test/config-gate.json` | C netpack 分帧/重组、watchdog-agent 绑定、PTYPE_CLIENT redirect、二进制/粘包/拆包回显 |
| lua-seri | `test/seri-tool gen build/seri-ref.bin` + `test/config-seri.json` | 字节级 roundtrip |
| cluster 双节点 | `test/config-cluster-a.json` + `config-cluster-b.json` | 跨节点 call（两个终端） |
| cluster 重连语义 | `test/config-cluster-fail.json`(套件 cluster_fail) | 对端宕机→call 立即失败；对端上线→按需重连成功 |
| 对比压测 | `make bench`(三阶段:core/cluster/socket) | SkyJS vs 原版 skynet 全套性能基线，方法学与数据见 [bench.md](bench.md) |
| 基准 | `test/config-bench.json` | 往返吞吐、JS 堆占用 |

与原版 Lua 节点的互通验收方式见根 README「验收状态」表。

## 目录结构

```text
platform/       # 内核替代层：env.c / main.c / lauxlib.h(纯 stub) / builtin-dl.c(STATIC=1 用)
service-src/    # snjs.c(QuickJS 服务加载器) / js-seri.c(序列化) / js-netpack.c(gate 帧缓冲) / skyclusterd.c(cluster)
cservice/       # 编译产物 logger.so / snjs.so / skyclusterd.so（gitignore）
js/             # JS 运行时库：skynet.js → socket.js → cluster.js → gateserver.js（按序加载）；
                # skyjs.d.ts 为全局注入面的 TS 类型声明（与库同源维护）
test/           # 验收配置(*.json) + service/ JS 服务脚本 + service-src/ C 测试服务
examples/       # TypeScript 接入示例（ts-echo：构建脚本 + 运行配置）
tools/          # 开发工具：run_tests/run_bench/run_interop/run_longrun（零依赖 node 脚本）
docs/           # 项目文档（本目录）
3rd/            # submodule，只读，永不修改
build/          # 中间产物（gitignore）
```

## C/JS 边界（关键 API 面）

> **口径说明（现状／迁移前）**：本节描述的是**当前代码**的扁平 `skynetcore.*`
> 命名与逐库加载键（`jsLoader`/`jsSocket`/`jsCluster`/…）。目标架构改为按能力
> 分组（`skynetcore.runtime`/`.fs`/`.net`/`.seri`/…）、单一 `require` 入口，加载键
> 收敛为 `jsBootstrap`/`jsModuleRoot`/`jsModuleSource`，详见
> [node-compatibility.md](node-compatibility.md) §16.3–16.5 与
> [infra/01-conventions.md](infra/01-conventions.md) §2–3。本节在重构落地前保持
> **现状口径**，与目标命名冲突时以目标设计为准，重构时同步改写本节。

`snjs.c` 向 JS 注入全局 `skynetcore` 对象：`send / redirect / command / intCommand / genId / now /
error / mem / response / errorResponse / pack / unpack / str / readFile / writeFile`，
以及 `skynetcore.socket`（`listen/connect/start/send/close/shutdown/nodelay/netpackMode`）与
`skynetcore.netpack`（`pop/pack/clear`）。

JS 侧加载顺序（env 键 `jsLoader` → `jsSocket` → `jsCluster` → `jsGateserver` → 用户脚本）：
`js/skynet.js` 定义 `globalThis.skynet` 与内部路由；`socket.js`/`cluster.js`/`gateserver.js`
通过 `__snjs_set_socket_handler` / `__snjs_set_cluster_handlers` 挂回调。
四个运行时库在 env 值为默认路径时走**内嵌字节码**（`make` 构建期由 qjsc 生成
`build/rt_bc.c`，strip 源码保留行号；源码或 quickjs submodule 变更自动再生），
非默认路径或字节码不可读时回退源码 eval；用户脚本始终走源码。
C 层在用户脚本执行完后用 `__snjs_wrap` 包一次 `globalThis.dispatch`，wrapper 统一负责
RESPONSE/ERROR 回包与 Promise 排空。

修改边界时的约定：

- 消息调度模型同构于 `lualib/skynet.lua`：session ↔ `pendingCalls`，await = yield；
  每个 await 都挂在外部事件上，保证 dispatch 返回时 pending job 队列已排空。
  **不要引入纯 JS 定时器/微任务挂起导致 worker 线程无法归还的机制。**
- 消息跨层类型契约（text=字符串 / lua 与响应=ArrayBuffer / pack-unpack 类型映射）
  固化于下节「二进制消息协议约定」，修改边界实现前先核对该节。
- 发送缓冲区所有权：C 侧 `skynetcore.send`/`skynetcore.response` 的
  skynet_malloc 缓冲一律以 `PTYPE_TAG_DONTCOPY` 发出（所有权移交内核，由
  接收方 dispatch 后释放）。不带该 tag 时内核会**复制**消息且原缓冲仍归
  调用方——漏 free 即按载荷全量泄漏（js_send 与 cluster 请求转发的既有
  教训）。新增 C 侧发送点二选一：带 tag 移交，或 send 后自行 free。
- **socket 接收缓冲所有权**：`PTYPE_SOCKET` 的 DATA/UDP 事件中，外层
  `skynet_socket_message` 与内部 `sm->buffer` 是两块独立分配；框架在 C 服务
  callback 返回 0 后只释放外层 `msg->data`，**内部 `sm->buffer` 归接收服务**。
  拷贝到 JS / 自有 rx buffer 后必须 `skynet_free(sm->buffer)`；若做 C 层链式
  socketbuffer，则由 push 接管并在 pop/clear 时释放。CONNECT/ACCEPT/ERROR 等
  padding 控制事件 `sm->buffer == NULL`，文本位于 `sm+1` 随外层一并释放。
  漏掉该规则会按累计接收字节全量泄漏（snjs socket / skyclusterd 的既有教训）。
- 底层 `TIMEOUT` 命令单位是 **centisecond(10ms)**；`skynet.sleep(ms)` 已做换算。
- `snjs.so` 静态编入 quickjs（`-fvisibility=hidden`），仅导出 `snjs_*` 四个 ABI 符号
  （dlopen 为 RTLD_GLOBAL，防符号冲突）。

## 二进制消息协议约定

JS 服务跨层收发消息的类型契约。实现锚点：snjs.c `worker_cb`（接收方向）、
`js_send`/`js_response`（发送方向），js/skynet.js `skynetCall`/`__snjs_wrap`。
协议常量同 skynet：PTYPE_TEXT=0、PTYPE_RESPONSE=1、PTYPE_CLIENT=3、PTYPE_SOCKET=6、
PTYPE_ERROR=7、PTYPE_LUA=10。修改 C/JS 边界时不得破坏本节语义。

### 跨层类型规则

接收（C → JS）：dispatch 拿到的 JS 类型由消息协议类型决定：

| 协议类型 | JS 侧类型 | 说明 |
|---|---|---|
| PTYPE_LUA、PTYPE_RESPONSE、PTYPE_CLIENT | `ArrayBuffer` | 原始字节拷贝，C 层不解释内容（binary-safe）；CLIENT 由 gate redirect 给 agent |
| PTYPE_TEXT 及其余全部类型 | UTF-8 字符串 | `JS_NewStringLen` 解码 |
| PTYPE_SOCKET | 预解析对象 `{type, id, ud, data}`，DATA 的 data 为 `ArrayBuffer` | socket.js 按连接选择 UTF-8 解码或原样交付；netpack 模式改为 `{np,event,...}` |

PTYPE_RESPONSE/PTYPE_ERROR 由 skynet.js 运行时路由（pendingCalls / 定时器 /
cluster 桥），不会进入用户注册的 dispatch。

发送（JS → C）：`skynetcore.send` / `skynetcore.response` 的消息参数传
`ArrayBuffer` 即二进制载荷原样透传，传字符串按 UTF-8 编码。dispatch 的返回值由
`__snjs_wrap` 原样交回 `response`（string / ArrayBuffer 均可），因此 lua 协议
服务的应答必须返回 `skynet.pack(...)` 打包的 ArrayBuffer（应答体按 seri 流解码），
text 协议服务返回字符串。

响应解码按调用方协议：应答统一以 ArrayBuffer 到达 JS 层，解码方式由
`skynet.call` 发起时的协议决定——`"lua"` 调用保持 ArrayBuffer，由调用方
`skynet.unpack`；text 协议调用由 skynet.js 以 `skynetcore.str` 解码为字符串再
resolve。

### skynet.pack / skynet.unpack 与 lua-seri 的兼容关系

`skynet.pack(...)` 返回 ArrayBuffer；`skynet.unpack(buf)` 返回按 seri 流顺序排列
的值数组（buf 亦接受字符串，按其 UTF-8 字节流解）。js-seri.c 与原版 lua-seri
字节级兼容（验收：`test/seri-tool` 对拍 + `test/config-seri.json` roundtrip），
pack 产物可跨 JS/Lua 节点互通。

JS → seri（pack）类型映射（多入口，回读一律为 LuaTable）：

| JS 类型 | seri 编码 |
|---|---|
| `null` / `undefined` | nil |
| `boolean` | boolean |
| `number` | 精确整数（绝对值 ≤ 2^53 且无小数部分）走整数编码（同 Lua 整数路径），其余 double |
| `BigInt` | 整数编码，按值选最小宽度（zero/byte/word/dword/qword），与同值 number 产物一致 |
| `string` | UTF-8 字符串，上限 0x7fffffff 字节 |
| `LuaTable` | **规范源**：`.array` 写数组段（键 1..n）+ `.hash` 写 hash 段，与 Lua 对 `{...}` 的编码字节一致 |
| `Array` | 语法糖：纯数组段（键 1..n） |
| `Map` | 语法糖：hash 段（整数键保持整数键） |
| 普通对象 | 语法糖：hash 段，取可枚举自有属性（键恒为字符串） |
| 其余（function、symbol 等） | 报错 "unsupported type" |

seri → JS（unpack）类型映射（1:1，接收侧无歧义）：

| seri 类型 | JS 类型 |
|---|---|
| nil | `null` |
| boolean | `boolean` |
| 整数 qword（超出 int32 表达范围，即 Lua 侧 64 位整数） | `BigInt` |
| 整数 zero/byte/word/dword、real | `number` |
| string | `string` |
| table（任意，含空表/纯数组/混合） | `LuaTable`（`.array` 为 0-based 数组段，`.hash` 为 Map；空表 → `LuaTable([], new Map())`） |
| userdata | **unpack 直接抛 TypeError**（指针跨 VM 禁传，与原版语义一致） |

### 边界行为备忘

- int64 经 BigInt 往返：Lua 侧 64 位整数 unpack 恒为 `BigInt`（不回退 number）；
  JS 侧表达超过 2^53 的整数必须自觉用 BigInt（number 在 pack 前已丢精度）。
  int32 范围内的整数双向均为 number，`BigInt(5)` 与 `5` 的 pack 产物一致。
- table 统一解为 `LuaTable`：`.array`（0-based，逻辑键 1..n）+ `.hash`（Map），
  `.get(k)`/`.set(k,v)` 镜像 Lua `t[k]`，`.len` 对应 `#t`。消除了旧方案的三处歧义：
  空 `[]`/`{}`/`new Map()` 打包后字节皆为 `06 00`，现统一解为空 `LuaTable`（不再塌缩为
  空 Map、不再丢失数组性）；数组段索引基准不再随 hash 段存在与否在 Array/Map 间翻转。
- 非对称契约：Array/Map/普通对象为便捷输入糖，回读一律为 `LuaTable`；如需严格对称往返，
  发送侧显式构造 `LuaTable`。**整数键 hash 必须走 `LuaTable.hash`/`Map`**——普通对象的
  数字键会被 JS 归一为字符串键（Lua 侧得到字符串键 `t["2"]` 而非 `t[2]`）。
- 嵌套深度超过 32 层 pack 报 "pack too deep"。

## Gate / netpack / redirect

`js/gateserver.js` 对齐原版 `snax/gateserver.lua` 的核心连接状态机，使用
`service-src/js-netpack.c` 处理 2 字节大端长度帧。netpack 队列为 per-service 单例：
DATA 到达时 C 层直接接管 `sm->buffer`，单包/分片按 fd 重组，多包进入 ring queue；
`netpack.pop()` 把完整包复制为 ArrayBuffer 后释放 C 缓冲，`netpack.clear()` 与
`snjs_release` 释放所有 queued/uncomplete 缓冲。gate 服务退出前无需 JS 手动析构，
但业务主动重置队列时应调用 clear。

`socket.start(..., {binary:true})` 使指定连接的 `onData` 接收 ArrayBuffer；默认仍通过
`skynetcore.str` 解码为字符串，保持既有 API。socket 写入接受 string、ArrayBuffer 与
TypedArray view。

`skynet.redirect(dest, source, typename, session, msg)` 可伪装 source，C 层为新分配缓冲
加 `PTYPE_TAG_DONTCOPY` 后移交内核。gate 将完整包以 PTYPE_CLIENT 转给 agent，session
携带 fd；CLIENT dispatch 禁止 `__snjs_wrap` 自动回包，agent 直接向 fd 写响应。验收场景
`test/config-gate.json` 覆盖 watchdog→agent 绑定、二进制载荷、粘包与拆包。

## 编码约定

C 代码风格与 `3rd/skynet/skynet-src` 一致：4 空格缩进、`snjs_`/`js_` 前缀、
结构体 `struct xx` 声明风格、函数定义返回类型独立一行。新增 C 文件需同步加入
`Makefile` 对应 SRC 列表（snjs 系需 `-fvisibility=hidden` 与 `-I3rd/quickjs`）。

JS 命名规范（camelCase，对齐 JS 生态惯例；项目目标为兼容 Node 代码，LLRT 路线）：

- 标识符（变量/函数/参数/公开 API/属性键/回调参数名/C 注入属性名）一律
  lowerCamelCase，复合词首字母大写（如 `findType`、`internalDispatch`、`setNodes`、
  `memStat`、`rawCmd`、`onData`）。
- 类/构造器 UpperCamelCase（`File`、`LuaTable`、`BufferedReader`）；内部单 `_` 前缀
  照用（`_onData`）。
- 常量 UPPER_SNAKE_CASE（`PTYPE_TEXT`）；禁止 `var`，一律 `const`/`let`；
  字符串双引号；缩进 4 空格。
- **文件名/目录名一律 kebab-case**（`io-main.js`、`config-cluster-a.json`、
  `rss-trim.sh`、`ts-echo.ts`、`bench-lua/`、`lua-stub.c`、`snjs-internal.h`）
  ——文件名与标识符解耦：文件名 kebab、内容标识符 camel（同 npm 生态惯例）。
  唯一例外：`platform/lauxlib.h`、`platform/lua.h` 保留原名——它们是遮蔽上游
  `3rd/skynet` include 路径的编译契约（skynet_main.c/malloc_hook.c
  `#include <lauxlib.h>`），改名即破坏零修改编译。

C/JS 边界：注入到 JS 的属性名同样遵守 JS camel 规范（`intCommand`、`genId`、
`readFile`、`writeFile`、`errorResponse`），由 snjs.c 的 `JS_SetPropertyStr` 注入，
改名必须 JS/C 同步；C 源码内部函数名（`js_*` 前缀，如 `js_intcommand`）是纯 C 侧
命名，不受 JS 规范管辖。`__snjs_*` 双下划线前缀与 `globalThis.dispatch` 是 C↔JS
调用契约（加载器依赖），JS 侧不得改名或删除。

**冻结域**（字符串字面量逐字保留，勿因"看起来是 snake"而改）：

> **口径说明（现状／迁移前）**：下面列的逐库加载键（`jsLoader`/`jsSocket`/…）是
> **当前实现**的冻结契约。目标架构把这些收敛为 `jsBootstrap`/`jsModuleRoot`/
> `jsModuleSource`（+ 原生产物的 `cpath`/`extpath`），见
> [node-compatibility.md](node-compatibility.md) §16.5、
> [infra/01-conventions.md](infra/01-conventions.md) §3。收敛完成前上面这些键仍是
> 逐字冻结的协议字符串；`int_command`/`intcommand` 一类退役名的规则与目标无关，
> 继续有效。

- env/config 键：`jsLoader`、`jsSocket`、…、`jsMemLimit`、`__json_config`、
  `thread/cpath/bootstrap` 等——配置域契约。
- 线协议与命令串：skynet 命令（GETENV/SIGNAL/EXIT/REG/NAME/LAUNCH/QUERY/TIMEOUT）、
  cluster 帧（`"node "`、`"req "` 等与 `.clusterd`）。
- io.js↔ioservice.js RPC op 串（`"read_file"` 等 9 个）与测试验收标记串
  （`"c_echo="`、`"js_mem="` 等）——字符串与方法名解耦，两侧字符串保持一致即可。
- 算法/架构域名词白名单：`iso7816_4`（ISO 7816-4）、`x86_64` 等保留原名。
- 旧 snake 名（int_command/gen_id/read_file/write_file 等）与旧连写名
  （intcommand/genid/readfile/writefile）均已退役，勿复用；后者在 lint 黑名单。

运行时库与服务脚本：

- `js/` 运行时库一律 IIFE + `"use strict"` 封装，内部符号不进全局，公开 API 仅挂
  `globalThis.skynet`/`socket`/`cluster`。**运行时零 npm 依赖**、无构建步骤。
- console 调试面（js/skynet.js 纯 JS 实现）：`log/info/debug/warn/error/trace` 全部
  映射 skynet 日志通道（`skynetcore.error`，带服务 handle 前缀进 logger）；参数递归
  渲染——Map 展开为条目、BigInt 带 `n` 后缀（避开 JSON.stringify 对 bigint 抛错）、
  ArrayBuffer/Uint8Array 输出长度+hex 摘要、嵌套对象、深度限 3。首参为含 `%` 的
  字符串时启用 printf 格式化（%s/%d/%i/%f/%j/%o/%%，未知/缺参占位符原样，多余
  参数追加尾部）；`time/timeLog/timeEnd` 用 Date.now 墙钟计时，纯观测不挂
  dispatch（方法名保持标准 console API 面，同 console.log）。
- 服务脚本（`test/service/`）不新增裸全局函数，统一 `skynet.start(() =>
  skynet.dispatch(...))` 范式；`globalThis.dispatch` 直接覆盖是早期同步形式的存量
  写法，勿模仿。未来引入第三方 JS 库保持其原有风格，仅自有代码遵循本规范。

构建与配置:

- **三平台构建**：Makefile 根据 `uname`/`OS` 判断平台，三分支产出相同结构：
  - macOS (arm64/x86_64)：`-dynamiclib`，`-ldl -lpthread -lm`
  - Linux (x86_64/aarch64)：`--shared`，`-ldl -lpthread -lm -lrt`
  - Windows (MinGW-w64)：`--shared`，`-lws2_32 -lgdi32 -lpthread -lm -static-libgcc`；
    通过 `-I` 和 `-include` 引用 skynet 自带的 `3rd/compat-mingw/`（`compat.h`），
    不新建额外兼容层文件。
  - Windows 功能退化：daemon 化（空操作）、pidfile 锁定（不生效）、SIGHUP 日志重开（不生效）。
  - `platform/main.c` 中 SIGPIPE 处理已用 `#ifndef _WIN32` 条件编译保护。
  - CI 通过 GitHub Actions 矩阵自动构建三平台(`.github/workflows/build.yml`)；
    Windows 测试套件暂未启用（依赖 POSIX 信号等工具链）。
- C 构建由 Makefile 负责（npm 管不到 C 编译链接）;package.json 管 JS 开发工具链
  （lint、TS 转译）。默认/内建发行不引入运行时 npm 依赖，`node_modules/` 不随产物
  发行；可选能力可由 `@skyjs/*` 包提供（含预编译原生产物或 C/C++ 源码，构建期
  链接），见 node-compatibility §3.1–3.2。
- **构建开关**（正交，可组合，默认全关）：
  - `STATIC=1`：把 `logger`/`snjs`/`skyclusterd` 静态链进 `skyjs`，产出单文件。
    实现遵守「不改 `3rd/`、也不接管 `skynet_module.c`」——仅在链接层 wrap `dlopen`
    （`platform/builtin-dl.c`）：命中内置模块名的路径返回 `dlopen(NULL)`（主程序自身），
    入口符号随 `-rdynamic`(Linux)/`-Wl,-export_dynamic`(macOS) 导出，原版 `dlsym` 原样命中；
    其余路径走真实 `dlopen`（**保留 fallback**，测试服务与第三方 `.so` 仍动态加载）。
    Linux 用 `-Wl,--wrap=dlopen`，macOS 用 dyld `__interpose`+`dlsym(RTLD_NEXT)` 取真实指针避免自递归。
    扩展内置清单改 `builtin-dl.c` 的 `builtin[]`。MinGW 不支持。
  - `RELEASE=1`：去 `-g`、`-O2`→`-Os`、`-ffunction-sections -fdata-sections` + 链接期
    section GC(`--gc-sections`/`-dead_strip`) 与 strip；`skyjs` ~5.7MB→~1MB。
  - 注意 logger（`service_logger.c`）无 `MODAPI` 可见性标注，其对象编译**不能**带
    `-fvisibility=hidden`，否则 `logger_*` 进不了 `-rdynamic` 导出表（snjs/skyclusterd 有 MODAPI 不受影响）。
- **TypeScript 接入**：运行时全局注入面的类型声明在 [js/skyjs.d.ts](../js/skyjs.d.ts)
  （与三个运行时库同源维护，**改注入面必须同步更新**）；TS 服务写好后用
  `examples/ts-echo/build.sh` 同款 esbuild 参数转译（`--bundle --format=iife
  --platform=neutral --target=es2022`，esbuild 仅构建期工具，npx 按需拉取），
  产物交 snjs 以源码模式加载（用户脚本始终走源码 eval，无模块包装）。完整
  流程见 `examples/ts-echo/`（tsc --noEmit 可选强检查）。
- 配置文件为**扁平 JSON**（`platform/main.c` 内置约百行解析器，不支持 `$VAR`/
  `include`）；新配置键直接写 env，skynet 相关键（thread/cpath/harbor/bootstrap/
  daemon/logger/logservice/profile）映射 `skynet_config`，JS 专属键（如
  `jsMemLimit`）由 snjs 读取。
- 提交前跑 `npm run lint`（eslint，`eslint.config.js` flat config）：双运行时
  overrides（QuickJS 侧注入 globals / tools 侧 Node 环境）+ `naming-convention`
  （camelCase/UPPER/Pascal + `iso7816_4` 白名单）+ `id-match` 退役名黑名单 +
  `no-var`/`no-tabs`。依赖装在 devDependencies（`npm install` 一次），CI 用 `npm ci`。
  旧零依赖 `tools/lint.js` 已删除（2026-09 换 ESLint）。
- 注释与文档用中文或英文均可，与所在文件现状保持一致；README.md 的架构表与验收
  矩阵、docs/HISTORY.md 的演进记录在行为变更后需同步更新。

## 功能边界（未实现清单）

当前无对应物的功能（未实现 ≠ 永久排除，取舍待推敲；如需引入，先与用户确认设计，
勿擅自顺手实现）：harbor 的 master-slave 多节点模式、snlua/launcher/debug_console、
inject 热更新、sharetable、snax、datacenter；cluster 侧未实现 clusterproxy、
cluster.snax，也未与 gateserver 复用监听。

## 排查问题的入口

- 服务日志：stdout 由 `logger.so` 输出；JS 侧用 `console.log/info/debug/warn/
  error/trace`（js/skynet.js 实现，全部映射到 skynet 日志通道），或直接
  `skynetcore.error`。cluster 侧对端未启动时每次请求失败的
  `socket-server error: invalid socket` 是 skynet 内核的固有噪音（每次
  connect 拒绝一条），非故障。
- 内存：per-service memstat（`skynetcore.mem()`），`jsMemLimit` 配 OOM 限额，
  OOM 表现为 JS 抛错可被捕获（见 `test/service/oom-worker.js`）。
- 死循环：SIGNAL 命令打断机制，见 `test/service/deadloop-worker.js`、
  `test/service/microtask-deadloop-worker.js` 与 snjs.c 头注释（注意：信号到达时
  若无 JS 在跑，陷阱会滞后到下一条消息；纯 microtask 链在 job 之间检查 trap，
  命中后退出该服务，不会留下可在后续消息中恢复的队列）。
- **KILL/跨服务命令参数是 `:hex` 格式**：内核 `tohandle()` 只认 `:十六进制`
  与 `.名字`，传十进制 handle 会被拒（仅一行 `Can't convert N to handle` 日志，
  极易淹没在噪音里导致操作静默失效）。正确写法
  `skynetcore.command("KILL", ":" + h.toString(16))`；若「内存随服务数线性增长」
  先 grep `Can't convert` 确认销毁是否真执行过，再查泄漏。
- 服务参数 `snjsParam` 在用户脚本 eval 完成后才注入（snjs.c post-JS_Eval），
  `skynet.start` 回调内（同步启动阶段）读到 undefined；需在首个 await 之后再读，
  或用 driver kick 模式（见 `test/service/bench-trim-main.js`、`longrun-main.js`）。
- 长跑稳定性与 memstat/RSS 对账：`make longrun`（`DURATION=N` 分钟，默认 30），
  harness 汇总 js_mem 与 RSS 的增长量（memstat 盲区）并落盘 `build/longrun/`。
- 其余已知限制（socket.start 重复事件、TIMEOUT 单位等）见 [TODO.md](TODO.md)
  「已知限制」一节。
