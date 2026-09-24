# SkyJS 历史演进与问题归因档案

> 本文档归档已完成的演进决策与历史问题归因（含错误归因的订正过程），仅作回溯
> 参考，不反映当前状态。当前遗留事项见 [TODO.md](TODO.md)，现行规范见
> [DEVELOPMENT.md](DEVELOPMENT.md)，最新性能基线见 [bench.md](bench.md)。

## 1. 版本控制与部署决策（v0.1，2026-09）

- **独立主工程**：skyjs 是 git 主仓库，不再依附原 skynet 工作目录（该目录
  废弃）；首次提交包含全部源码与两个 submodule 引用。
- **submodule URL 均指向上游 GitHub**：`3rd/skynet` → cloudwu/skynet，
  `3rd/quickjs` → quickjs-ng；两者绑定的 commit 均在各自 origin 分支可达，
  全新环境 `git clone` + `git submodule update --init` 即可完整恢复。
- **quickjs-ng 已转 submodule**：`3rd/quickjs/` 以 shallow 方式添加
  （`--depth 1`），固定于构建验证过的上游 commit；`.gitmodules` 与 gitlink
  均已就位。
- **`.gitignore` 已补**：忽略 `/skyjs` 主程序二进制、`build/`、`cservice/*.so`、
  `test/cservice/*.so`、`test/seri_tool` 与 `*.dSYM`。
- **原版构建产物未跟踪**：与原版互通验收需在 `3rd/skynet` 内执行 `make`
  （生成 `./skynet`、luaclib/、cservice/ 等，均为未跟踪文件），不影响
  "skynet 源码零修改"承诺；清理用 submodule 内 `make clean`。

## 2. 历史问题归因档案

### 2.1 js_send 与 cluster 请求转发缓冲泄漏（2026-09-19 修复）

- **Bug 类别**：C 侧发送缓冲所有权泄漏。
- **根因**：`skynetcore.send`/`skynetcore.response` 及 skyclusterd 的 cluster
  请求转发在 `skynet_malloc` 缓冲上发出时未带 `PTYPE_TAG_DONTCOPY`——不带该
  tag 时内核会**复制**消息且原缓冲仍归调用方，调用方漏 free 即按载荷全量泄漏。
- **修复模式**：一律带 `PTYPE_TAG_DONTCOPY` 发出（所有权移交内核，由接收方
  dispatch 后释放）。该契约已固化于 DEVELOPMENT.md「C/JS 边界」。
- **教训**：修复前旧基线 `send` 按载荷全量泄漏，曾把 RSS 峰值 1025.5MB 与
  「1.4MB/服务」错误归因为"JS 服务常驻内存大"——2026-09-19 旧基线内存数据
  作废。

### 2.2 socket 接收缓冲（sm->buffer）泄漏（2026-09-20 修复）

- **Bug 类别**：PTYPE_SOCKET DATA 事件缓冲所有权泄漏。
- **根因**：skynet socket 线程为每条 DATA 单独 `MALLOC` 接收缓冲；外层
  `skynet_socket_message` 与内部 `sm->buffer` 是两块独立分配，框架只释放外层。
  `snjs.c worker_cb` 在 `JS_NewStringLen` 拷贝后、`skyclusterd` 在 `conn_data`
  拷贝后均漏释放，每条 TCP DATA 按包长泄漏（RSS 与累计接收字节成正比：
  64KB×10000≈640MB，65536B echo 时 JS 服务端 RSS ~900MB vs lua ~35MB）。
- **修复模式**：两处补 `skynet_free(sm->buffer)`。契约固化于 DEVELOPMENT.md
  「socket 接收缓冲所有权」。
- **教训**：修复前曾被错误归因为"拷贝放大 + 分配器留存/高水位"，RSS 与累计
  接收字节的线性关系是反证泄漏归因的关键线索。

### 2.3 「JS 服务常驻内存大」错误归因订正（2026-09-20）

- 旧基线「1.4MB/服务、RSS 峰值 1GB vs 360MB」是 2.1 的 js_send 泄漏造成的
  误归因。修复后正式基线：core RSS 峰值 235.3MB vs 270.3MB；真实单服务基线
  snjs ~0.25MB vs snlua echo ~0.054MB（~4.6x，QuickJS runtime 堆 0.148MB）。
- 曾考虑的"单纯 ArrayBuffer 二进制路径"对 RSS 无可测收益（同样受 2.2 所有权
  泄漏支配），不作为内存优化落地；per-connection binary 仅按正确性/API 能力
  立项。

### 2.4 mixed 40KB cluster RTT 异常证伪（2026-09）

- 曾观察到 cl_mixed 40KB 场景 109 msg/s 的异常低谷。payload 扫描（100B/8KB/
  20KB 单帧与 40KB/80KB 分帧）证明 cluster RTT 与包大小/分帧无关，全被响应
  方向 Nagle 平台主导；109 msg/s 为运行瞬态（复测 535）。无需代码修复。
- 相关结论：cluster 小包串行 RTT（约 2.9-4ms）被两侧响应方向均不设
  TCP_NODELAY 的共有特性绑死；pipelined（多在途）场景可绕开（见 bench.md）。

### 2.5 测试与工具链历史教训

- **KILL 命令参数必须是 `:hex` 格式**：传十进制 handle 静默失效（仅一行
  `Can't convert N to handle` 日志，极易淹没）。排查"内存随服务数线性增长"
  先 grep `Can't convert` 确认销毁是否真执行过。正确写法
  `skynetcore.command("KILL", ":" + h.toString(16))`。
- **snjs_param 注入时机**：服务参数在用户脚本 eval 完成后才注入（snjs.c
  post-JS_Eval），`skynet.start` 回调内（同步启动阶段）读到 undefined；
  需在首个 await 之后再读，或用 driver kick 模式。
- **cluster 端口残留**：2528/2529/2530 残留监听进程会导致后续 cluster 验收
  挂起/误判，跑 cluster 相关测试前先确认端口干净（harness 已内置
  free_cluster_ports 清理）。
- **seri fixture 路径漂移**：对拍参考数据曾因生成/消费路径不一致被临时文件
  残留掩盖；`build/seri_ref.bin` 为唯一权威路径。
- **watch_markers 的 'must all match then kill' 模型**：测试哨兵若包含在正常
  流程中永不出现的行会导致整轮挂起；新增断言标记前先核对目标脚本确实会打
  出该行。

## 3. 已落地的功能演进记录（2026-09）

1. **cluster 重连语义对齐官方**：核对官方源码发现 cluster 路径
   （socketchannel 一律 connect-once）本无后台重连——重连完全由下一次请求
   驱动，每请求至多一次 connect 尝试，失败立即报错。skyclusterd 删除了早期
   的固定 1s 后台重试（arm_retry/node_retry_all），断线时立即 PTYPE_ERROR
   失败该节点全部 pending 请求并清空待发帧。原计划"指数退避+抖动"作废。
   验收场景 `test/config_cluster_fail.json`。
2. **skyclusterd 分帧组装抽公共层**：inbound/outbound 的 multipart 重组合并
   为 `struct reasm` + `reasm_start/chunk/clear`；响应侧重组后的冗余 memcpy
   一并消除（所有权直传 PTYPE_TAG_DONTCOPY）。发送侧拆分不合并（响应
   `<=MULTI_PART`、请求 `<MULTI_PART` 的 threshold 语义系对拍原版逐字节行为）。
   验收含 40KB 双向大帧断言（CLUSTER BIG OK: 40005）。
3. **二进制消息协议文档化**：跨层类型契约（text=字符串 / lua 与响应=
   ArrayBuffer / pack-unpack 类型映射）固化于 DEVELOPMENT.md。
4. **TypeScript 接入**：类型声明 `js/skyjs.d.ts`（与运行时库同源维护）+
   示例 `examples/ts_echo/`（esbuild 剥离类型为 iife 纯 JS，snjs 源码模式
   加载，无需改 C 层）；验收输出 TS_ECHO_OK。
5. **互通测试一键化**：`make interop` 串联 submodule 增量构建 → 端口清理 →
   skyjs 互配节点（须先起）→ 原版 Lua 节点 → 双向断言。注意原版节点每次
   启动都会打 `KILL self`（bootstrap 服务自退），互配脚本的 NEVER 哨兵只
   作用于 skyjs 流。
6. **console 面增强**：time/timeLog/timeEnd（墙钟计时，纯观测不挂 dispatch）
   与 printf 风格格式化（%s/%d/%i/%f/%j/%o/%%）；独立 stdout 通道经评估
   不做（保持单日志通道，见 important decision）。
7. **cluster 发送方向 TCP_NODELAY 对齐官方**：原版 clustersender.lua
   `nodelay = true`，skyclusterd 出站连接补上（仅发送侧，接收方向与原版
   clusteragent 一致保持默认）。
8. **对比压测套件**：`make bench` 三层对比（core/cluster/socket），方法学与
   数据见 bench.md。
9. **性能优化首轮**（均经同机同时段 A/B 对照确认）：
   - js-seri 写缓冲重构：连续几何增长缓冲 + ArrayBuffer 零拷贝交接，
     `sp_s64k` 净收益 ~4x。
   - 运行时库字节码化：qjsc 构建期生成 skynet/socket/cluster.js 字节码，
     `startup_self` 净收益 ~1.9x（对 snlua 达 4.76x）。
   - **边界发现：quickjs 的 Map 为链表实现，Map.set O(n) 查重使大表 unpack
     为 O(n²)**（纯 JS 可复现），在 table→Map 契约下 `sp_t1000` 类场景无
     优化空间；突破需契约变更（数组型 table 解为 Array）或引擎 patch，待
     另行评估。
10. **长跑对账落地**：`make longrun`（默认 30 分钟）持续混合负载 + 服务侧
    每秒打 tick + harness 侧 RSS 序列，结束对账 js_mem 与 RSS 增长量并落盘
    build/longrun/*.json。30 分钟基线（M4 Pro，2026-09-20）：~42 万 ops 吞吐
    零漂移；js_mem 全程平坦（0.3MB，增长 0）；RSS 15.3MB→4.5MB（macOS 内存
    压缩归还页）——含每分钟 120 个临时服务创建/销毁下无泄漏，memstat 盲区
    在 30 分钟尺度上不可测（≤RSS 噪声）。
11. **pending job 排空的 SIGNAL 边界**（行为变更，2026-09-22）：`worker_cb` 的
    `JS_ExecutePendingJob` 排空循环补两项处理——job 返回 -1 时经 `dump_exception`
    输出并消费异常；每个 job 之间检查 `trap`，命中则记录 `snjs pending job loop
    interrupted` 并 `EXIT` 退出该服务。回归测试证明极短的 Promise job 可能执行
    不到 10000 条字节码，QuickJS 的解释器轮询不触发，仅靠 `interrupt_handler`
    无法打断纯 microtask 链；此前该链会永久占住 worker 且残留队列会在后续消息
    中继续执行，故中途退出循环不够，必须退役服务。`run_tests.js` 为此新增
    per-scenario `allow` 白名单（deadloop 场景预期出现 `KILL self`）。
12. **async 验收补并发挂起覆盖**（2026-09-22）：新增 B→C→D 回调重入场景
    （B 挂起等 C 时 D 再次调用 B）与双 session 场景（B 并发两个 `skynet.call`，
    X 故意先回第二个再经 timer 回第一个），断言各自收到带 token 的响应，验证
    session↔Promise 路由不会交叉错配。
13. **命名规范 snake_case → camelCase 硬切换**（2026-09-23）：项目目标定为
    兼容 Node 代码（LLRT 路线）后，JS 侧命名从 lower_snake_case 全面迁移到
    lowerCamelCase（类 UpperCamelCase、常量 UPPER_SNAKE_CASE 不变）——约 2400 处
    标识符经一次性词法 codemod 转换（字符串/正则/模板/注释内不动，冻结域因此
    自动保全），C 侧仅同步 `JS_SetPropertyStr`/`JS_NewCFunction` 的属性名字符串
    与结果对象键（C 函数/变量/符号保持原规范）。冻结域清单：env/config 键
    （js_loader 等）、skynet 命令串、cluster 线协议串、io.js↔ioservice.js RPC
    op 串（"read_file" 等仍为 snake，方法名照常 camel）、测试验收标记串、算法
    域名词（iso7816_4）。顺带修复 d.ts 与 js-crypto.c 的 keypair 结果键不一致
    （public/secret → publicKey/secretKey）。`tools/lint.js` 规则同步反转
    （camel 正则 + iso7816_4 白名单 + 旧 snake 名退役黑名单）。基础设施文档
    （docs/infra/00-15）签名同步机械 camel；新库按 Node 形状重写是后续独立批次。
14. **自研 lint 退役，切换 ESLint**（2026-09-23）：删除 `tools/lint.js` 与 `make lint`
    目标，换 `eslint.config.js`（flat config）+ `npm run lint`。规则迁移：语法/禁
    var/禁 tab 走内置规则；命名走 `@typescript-eslint/naming-convention`
    （camelCase/UPPER/Pascal + `__` 前缀豁免 + `iso7816_4` 白名单）；退役名黑名单
    走 `id-match` 负向前瞻（仅标识符，字符串字面量不查）。双运行时 overrides：
    QuickJS 侧（js/、test/service/、examples/）声明 snjs 注入 globals，tools/
    侧声明 Node 环境。AST 级检查顺带修了自研版查不到的问题：cluster.js 两处
    注释分隔 tab、websocket.js readHandshake 中无用赋值 `method`、
    nested-config-main.js 冗余初始化 `frozenOk`、ts-echo.ts 类型名 Pascal 化。
    工具链引入 devDependencies（eslint + ts-eslint 插件），CI 两处 `make lint`
    改为 `npm ci && npm run lint`；运行时零 npm 依赖不变。迁移顺带发现 id-match
    语义为"必须匹配"，黑名单需负向前瞻表达（首次配置正向写法导致全库误报）。
15. **config JSON 键与 env 键全面 camel 化**（2026-09-23）：配置域原属冻结域，用户
    决策推翻之——config 键跟随 JS 命名规范。改动面：全部 test/examples config JSON
    （`js_memlimit`→`jsMemLimit`、`bootstrap_param`→`bootstrapParam`、
    `test_*`→`test*`）；snjs.c 的 12 个 env 键字符串（`js_loader`→`jsLoader` 等
    11 个 loader 键 + `jsMemlimit` 定名 `jsMemLimit`——"limit" 是一个词，不拆
    成 `jsMemlimit`）；nested-config-main.js 的 9 个 `getenv` 字符串实参同步。
    注意：skynet 框架键（thread/cpath/bootstrap/logservice/profile 等）原为单词，
    无 snake 可改；`3rd/skynet` 内核消费的键不受影响（env store 透传）。
    顺带清理 config-nested.json 的死键 `js_path`（无任何消费者）与无消费者的
    `bootstrap_param`（snjs 参数走 bootstrap 命令行空格分段，不经此键）——后者
    保留仅为文档示意。冻结域相应收缩：env/config 键不再整域冻结，仅剩协议串/
    标记串/域名词。
16. **文件名/目录名统一 kebab-case**（2026-09-23）：标识符 camel 化之后，文件名
    层仍有 snake（96 处）/kebab（13 处）混用，用户决策统一为 kebab-case（机械
    规则：每个 `_`→`-`）。git mv 100 个跟踪文件与 3 个 snake 目录
    （examples/ts-echo、test/bench-lua、test/cluster-lua）；引用同步 437 处
    （config bootstrap、服务脚本 newservice 字符串、tools require/场景表、
    Makefile、shell、C include snjs-internal.h、docs、lua 配置内路径），其中
    build/ 生成物字面量（config-mem-js-、seri-ref.bin 等）一并 kebab 化。
    platform/ 三个 C 文件一并 kebab 化（lua-stub.c/mingw-compat.c/
    builtin-dl.c；lauxlib.h/lua.h 保留原名——它们是遮蔽上游 include 路径的
    编译契约）；snjs_internal.h 改为 snjs-internal.h。至此全库（除本文档
    历史条目与 3rd/ submodule）无 snake 文件名。本文档为 append-only 档案，
    旧条目中的旧文件名保留原样。
17. **Node 兼容层 NC0.1 起步**（2026-09-24）：落地构建期模块清单生成器
    （`tools/gen-module-manifest.js`，扫描 bootstrap/loader/internal/builtins 并记录
    SHA-256；`make test` 增加清单自校验）、`service-src/js-runtime.c` 与
    `skynetcore.runtime.*` 原语（exit/exitCode/argv/info/hrtime/environ/
    readModuleSource，开发期 `jsModuleSource=disk`），并新增 features 冒烟场景。
    本批不改旧调用方；完整 `skynetcore` 分组与能力表在 NC0.3 收敛。
18. **Node 兼容层 NC0.2：CommonJS loader 自举**（2026-09-24）：新增
    `js/loader.js`（Module 解析/缓存/包装、相对与绝对路径、目录与
    `package.json#main`、JSON 模块、基础 `node_modules` 查找、循环引用与模块局部
    `require`）、`js/internal/module-registry.js`（内建/私 internal 规则表）与
    `js/internal/path-posix.js`（与未来 `path` 共用的 POSIX 语义）；`snjs.c` 以普通
    脚本装载 loader，经 `js/bootstrap.js` 注册内建表并运行服务入口，同时用隐藏
    `__snjs_realpath` 收敛 C/JS 路径。CJS wrapper 保留模块自身 strict 语义；用户模块
    访问 `internal/*`/`node:internal/*` 会被拒绝。新增 module-system 场景覆盖缓存、
    循环、五件套、JSON/目录、权限与泄漏；ESLint 允许 QuickJS 侧 CJS 包装参数。
    旧 lazy global 注入原样保留，调用方迁移留待 NC0.7/NC0.8。
19. **Node 兼容层 NC0.3：skynetcore 分组与能力表**（2026-09-24）：`skynetcore`
    按能力分组挂载为 `runtime`/`fs`/`net`/`seri`，旧扁平名 `io`/`socket`/
    `pack`/`unpack`/`str` 与顶层原语继续双挂至 NC0.8；`snjs.c` 只负责规则化装配，
    `js-io.c`/`js-seri.c`/`js-net.c` 各自注册命名空间。`service-src/js-net.c`
    作为 socket 与 netpack 帧缓冲的统一实现（同源维护）。`skynet.features()` 落地基础
    能力表（`version`、`fsAsync`/`httpStream`/`subprocess` 等未落地能力报
    `available:false` + `ERR_UNSUPPORTED_PLATFORM`，`cryptExt` 随 OpenSSL 开关），
    构建期从 `package.json` 注入版本号；`js/skyjs.d.ts` 同步分组与能力表类型。
    新增 skynetcore-groups 验收覆盖新旧名同值、seri round-trip 与 features 报告。
20. **Node 兼容层 NC0.4：事件循环、定时器与 nextTick**（2026-09-24）：新增
    `js/internal/event-loop.js` 统一 tick 入口，顺序固定为 nextTick → Promise
    microtask → immediate → 到期 timer；`setTimeout`/`clearTimeout`/`setInterval`/
    `clearInterval`/`setImmediate`/`clearImmediate`/`queueMicrotask`/
    `process.nextTick` 与 ref/unref/refresh 全局落地。
    `snjs.c` 的 worker 边界统一调用 event loop，pending-job drain 收敛为共享 helper；
    `js/bootstrap.js` 安装全局并注入内部 tick/drain 钩子。新增 timers 场景覆盖纯
    定时器自推进、immediate 先于 timeout(0)、nextTick/microtask/timer 顺序。
