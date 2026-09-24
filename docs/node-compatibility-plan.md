# SkyJS Node 兼容层分批实施计划

本文是 [node-compatibility.md](node-compatibility.md)（下称"基线文档"）的执行计划：
基线文档定义架构、命名、语义与批次出口标准（唯一定义处），本文定义**执行顺序、
子批拆分、文件级任务、验收命令、提交策略与状态记录**。两者冲突时以基线文档为准；
执行中发现基线问题，先修基线文档，再同步本文。

依据：基线文档 §13（实施批次）、§15（现状缺口）、§16（目标架构）；人力与日历
估算见 [infra/15-roadmap-estimates.md](infra/15-roadmap-estimates.md)（本文不重复
估算，只对齐批次映射）。

## 1. 通用执行规则（硬规则）

1. **每个子批收尾必须全绿**：`make && make test` 通过，不跨子批留下不可构建或
   验收失败的状态（[infra/15-roadmap-estimates.md](infra/15-roadmap-estimates.md) §15.6）。开发过程中的中间提交也保持可构建。
2. **验收先行**：每个子批先落验收用例（`tools/run-tests.js` 场景 / `test/unit/` /
   `test/node-compat/`），再写实现；实现以让验收通过为完成标准。
3. **提交拆分**：C 原语 / JS 模块 / 测试 / 构建接线分开提交；提交信息不带 AI 署名
   （AGENTS.md）。
4. **允许的过渡态只存在于 NC0 开发期内**（§16.12 顺序 1）：
   - 旧全局注入（`lazy_setup_js`）与新 require 装载临时并存；
   - `skynetcore` 新旧分组双挂（旧扁平名 + 新 `fs`/`net`/`seri`/`runtime` 分组）；
   - `http`/`socket`/`sockethelper`/`websocket` 以 CJS 内部件形态临时存活。
   三者都在 NC0.8 收口删除，不对外发布双入口。
5. **并行禁区**：NC0.1–NC0.2（模块系统）与 NC0.4（事件循环）完成前，不开
   `fs`/`http` facade，避免出现第二套模块机制（§16.12）；NC2 的完整 `fs` 不允许
   拆分后置（§8.1）。
6. **每子批完成后**：`docs/HISTORY.md` 追加一条记录，本文 §3 状态表打勾。
7. 永不修改 `3rd/`；包不得 `require('js/internal/*')` 或直接调用 `skynetcore.*`
   （§16.4.1 硬规则 1）。

## 2. 验收命令基线

| 命令 | 用途 | 现状 |
|---|---|---|
| `make` | 构建主程序 + cservice | 已有 |
| `make test` | 全量验收（`node tools/run-tests.js` + seri 对拍） | 已有 |
| `npm run lint` | JS 静态检查 | 已有 |
| `node --test test/unit/` | 纯逻辑单测（Node 即真值，§16.10） | NC0.6 起步 |
| `node tools/run-node-compat.js` | Node 20 / SkyJS 双侧对拍 | NC1.2 落地 |
| `./skyjs test/config-<scenario>.json` | 单场景手工复现 | 已有 |

`tools/run-tests.js` 需随批次增强两点：子进程退出码校验（NC0.5 的 `process.exit(3)`
场景）；node-compat 双跑入口挂接（NC1.2）。

## 3. 批次总览与状态

| 子批 | 交付主题 | 依赖 | 状态 |
|---|---|---|---|
| NC0.1 | 构建期模块清单 + `js-runtime.c` 原语 | — | 已完成 |
| NC0.2 | CJS loader + bootstrap 自举 | NC0.1 | 已完成 |
| NC0.3 | `skynetcore` 分组重命名 + `features()` | NC0.1 | 已完成 |
| NC0.4 | 事件循环 + 定时器 + nextTick | NC0.2 | 已完成 |
| NC0.5 | `process` 核心 + 宿主退出 | NC0.2、NC0.4 | 已完成 |
| NC0.6 | events / Buffer / abort / text-codec / console | NC0.2、NC0.3 | 已完成 |
| NC0.7 | 现有库 require 化迁移 | NC0.2–NC0.6 | 已完成 |
| NC0.8 | NC0 收口 | NC0.1–NC0.7 | 未开始 |
| NC1.1 | `internal/errors` 错误层 | NC0.8 | 未开始 |
| NC1.2 | path / util / querystring / url / os + 单测设施 | NC0.8 | 未开始 |
| NC1.3 | `require('buffer')` + `Blob`/`File` 全局 | NC0.6 | 未开始 |
| NC1.4 | `internal/binary-frame` | NC1.1 | 未开始 |
| NC1.5 | 基础 `node_modules` 查找 | NC0.8 | 未开始 |
| NC1.6 | `skyjs/log` + `skyjs/testing` | NC0.8 | 未开始 |
| NC2.1 | `internal/stream-core` + `require('stream')` | NC1.1、NC1.4 | 未开始 |
| NC2.2 | `internal/permission` + `.fs` owner + 二进制通道 | NC1.4 | 未开始 |
| NC2.3 | `js-io.c` → `js-fs.c` 重构 + 原语扩展 | NC2.2 | 未开始 |
| NC2.4 | 完整 `fs` facade + `skyjs/fsx` | NC2.1–NC2.3 | 未开始 |
| NC2.5 | fs 出口专项验收（对拍/内存/fd） | NC2.4 | 未开始 |
| NC3.1 | `js-subprocess.c` C 原语 | NC0.8 | 未开始 |
| NC3.2 | `.subprocess` owner + `internal/subprocess-core` | NC3.1、NC2.2 | 未开始 |
| NC3.3 | `child_process` facade + 移动端开关 | NC3.2 | 未开始 |
| NC4.1 | `internal/net-core` 合并（删 socket 过渡件） | NC0.8、NC2.1 | 未开始 |
| NC4.2 | `require('net')` + `require('tls')` | NC4.1 | 未开始 |
| NC4.3 | `internal/http-core` + `http`/`https` + `fetch` | NC4.2 | 未开始 |
| NC4.4 | `internal/crypt-core` + `crypto`/`zlib` | NC0.8 | 未开始 |
| NC4.5 | 网络收口（删 http 过渡件、移除 `httpc`） | NC4.1–NC4.4 | 未开始 |
| NC5.1 | `js-native.c` 装载原语 | 可选 | 未开始 |
| NC5.2 | `internal/native-loader` + `extpath` + `skyjs.native` | NC5.1 | 未开始 |
| NC5.3 | 静态注册表 + 示例扩展 | NC5.2 | 未开始 |
| PKG-* | 8 个 `@skyjs/*` 包逐个搬出 | NC2 起，见 §10 | 未开始 |

与 [infra/15-roadmap-estimates.md](infra/15-roadmap-estimates.md) 估算批次的映射：NC0+NC1 ≈ B0（模块系统/事件循环底座）；NC2 ≈ B1
（core-runtime 的 fs 部分）；NC3/NC4 ≈ B3/B4（网络、子进程、crypto）；包批次 ≈
B2/B5/B7 中带包的行。决策门 1（模块系统/事件循环达标）在 NC1 出口评估。

首版发布门禁 = **NC0–NC2 全部出口达标**（§13）；NC3–NC5 与包批次不改变门禁定义。

## 4. NC0 运行时底座（详细计划）

NC0 解决 §15.6 前两块拦路石（模块系统、事件循环），并完成横切收敛
（`skynetcore` 分组 + `features()`——两者一次性触碰所有 facade，必须在后续批次
铺开前收敛，§13）。

### NC0.1 构建期模块清单 + `js-runtime.c` 原语

**交付**

- `tools/gen-module-manifest.js`：扫描 `js/bootstrap.js`、`js/loader.js`、
  `js/internal/**`、`js/builtins/**` 生成模块清单（§16.9 清单范围）；清单带内容
  hash，供发布模式校验。
- `service-src/js-runtime.c`（新建）：`skynetcore.runtime.*` 全套原语
  `exit`/`exitCode`/`argv`/`info`/`hrtime`/`environ`/`readModuleSource`（§16.5）。
  本子批只挂原语，不改任何调用方。
- `Makefile`：编入 `js-runtime.c`；`all` 依赖模块清单生成；`clean` 清理清单产物。
- env 键 `jsModuleSource` 接线（开发源码模式先行；字节码模式在 NC1.5 后按
  [infra/13-build-ci.md](infra/13-build-ci.md) §13.2 补齐，不阻塞 NC0）。

**验收**

- `make && make test` 全绿（本子批不改变行为）。
- 清单自校验：脚本对比磁盘文件与清单条目，缺失/多余即失败（并入 `make test`）。
- 新增场景 `test/config-features.json`（配对 `test/service/features-main.js`，挂
  `skynet.features()` 冒烟；features 结构见 [infra/01-conventions.md](infra/01-conventions.md) §5）。

**提交拆分**：清单脚本 + Makefile / `js-runtime.c` 原语 / 验收场景。

### NC0.2 CJS loader + bootstrap 自举（临时并存）

**交付**

- `js/loader.js`：`Module._resolveFilename`/`_load`/`_cache`（realpath 索引）/
  `wrap`，CJS 包装器（`module`/`exports`/`require`/`__filename`/`__dirname`）、
  循环引用处理（§16.3）。
- `js/internal/module-registry.js`：内建模块 id → 实现映射（规则化，非逐条硬编码，
  §3 表）；`js/internal/path-posix.js`（loader 与 `path` 共用的平台路径语义）。
- `js/bootstrap.js`：注册内建表、装配 §3 全局清单、`require` 服务入口（本子批
  先装配 `require` 五件套与已就绪全局，其余全局随 NC0.4–NC0.6 增补）。
- `snjs.c`：自举顺序切换——C 侧注册 `skynetcore` 桥、以**非模块脚本**装载
  `js/loader.js`，loader `require('js/bootstrap.js')`（ND-37）。
- **过渡**：`lazy_setup_js` 与旧全局注入原样保留；现有服务继续走旧路径，本子批
  不迁移任何调用方。

**验收**

- 新增场景 `test/config-module-system.json`（配对 `test/service/module-system-main.js`）：覆盖 require 局部性（模块内 `require`
  不泄漏为全局）、缓存命中（同 id 返回同一 exports）、循环引用（拿到未完成 exports
  不死锁）、`__filename`/`__dirname` 正确。
- `make test` 全绿（旧路径零回归）。

**提交拆分**：loader + path-posix / module-registry / bootstrap / snjs.c 自举切换 /
验收场景。

### NC0.3 `skynetcore` 分组重命名 + `features()`

**交付**

- `snjs.c` 挂载改为按 §16.5 分组：`skynetcore.io.*`→`skynetcore.fs.*`、
  `skynetcore.socket.*`→`skynetcore.net.*`、`pack`/`unpack`/`str`→
  `skynetcore.seri.*`、`runtime.*`（NC0.1 已建）；`netpack` 保留。
- `service-src/js-netpack.c` 物理并入 `service-src/js-net.c`（§16.11 迁移表）。
- **临时双挂**：旧扁平名继续可用（仅 NC0 开发期，NC0.8 删除），保证每个提交全绿。
- `skynet.features()` 完整落地（结构对齐 [infra/01-conventions.md](infra/01-conventions.md) §5；`fsAsync`/`httpStream` 等
  按能力实际编入状态报告，未落地能力报 `available: false`）。
- `js/skyjs.d.ts` 同步分组类型与 `features()`。

**验收**

- 新增场景 `test/config-skynetcore-groups.json`（配对 `test/service/skynetcore-groups-main.js`）：新旧两组名同值可用；
  `features().version` 与运行时版本一致、未编入能力报 `false` + reason。
- `make test` 全绿。

**提交拆分**：分组挂载（双挂）/ js-netpack 并文件 / features() / d.ts 更新。

### NC0.4 事件循环 + 定时器 + nextTick

**交付**

- `js/internal/event-loop.js`：唯一 tick 入口，顺序为 nextTick → microtask →
  immediate → 到期定时器（§16.7）；`process.nextTick` 独立队列。
- 全局 `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`setImmediate`/
  `clearImmediate`/`queueMicrotask`（§5.1），语义含 unref/ref、`skynet.timeout(0)`
  自唤醒（§5.2：注册 immediate 或首个到期定时器时自唤醒一次）。
- `snjs.c`：`worker_cb` 与定时器回调统一调用 `eventLoop.tick()`；nextTick 与
  Promise microtask 的 drain 顺序接入 C 侧钩子（§5.3）。

**验收**

- 新增场景 `test/config-timers.json`（配对 `test/service/timers-main.js`，三组断言进 `tools/run-tests.js` marker）：
  1. **纯定时器程序自行推进**（无任何外部消息，`setTimeout` 回调触发）；
  2. `setImmediate` 先于 `setTimeout(0)`；
  3. `process.nextTick` 先于 Promise microtask、两者先于 timer。
- `make test` 全绿。

**提交拆分**：event-loop / 定时器全局 + 自唤醒 / C tick 驱动 / 验收场景。

### NC0.5 `process` 核心 + 宿主退出

**交付**

- `process` 对象按 §4.5 成员表：`version`/`versions`/`platform`/`arch`/`pid`/
  `ppid`/`argv`/`argv0`/`execPath`/`env`/`cwd()`/`chdir()`（抛
  `ERR_UNSUPPORTED_PLATFORM`）/`exit()`/`nextTick`/`exitCode`/`hrtime`/
  `memoryUsage`/`uptime`/`stdout`/`stderr`（最小可写实现）；表外成员为
  `undefined`，`stdin` 为 `null`。
- `process.env`：宿主 environ 的 Actor 局部快照（§4.2，来源
  `skynetcore.runtime.environ()`）。
- `process.exit()`：写退出码 → 触发 skynet 命令 `ABORT` → 抛内部哨兵异常；
  `worker_cb`/`init`/`dispatch` 边界识别哨兵并静默返回；ABORT 后停止 pending-job
  drain（§4.1 全部规则，含 try/catch 可拦截哨兵的已知差异记入 §12）。
- `platform/main.c`：`skynet_start()` 返回后读退出码槽位并 return（替代固定
  `return 0`）；`process.exitCode` 写同一槽位，自然关停时生效。
- `tools/run-tests.js`：新增子进程退出码校验能力。

**验收**

- 新增场景 `test/config-process-exit.json`（配对 `test/service/process-exit-main.js`）：`process.exit(3)` 后宿主退出码为 3
  （runner 校验 exit code，不只看日志 marker）；`exitCode = 7` + 自然关停同样校验。
- `make test` 全绿（默认退出路径回归）。

**提交拆分**：`js-runtime.c` exit 通道增强 / main.c 退出码 / process 对象 /
runner 退出码校验 / 验收场景。

### NC0.6 events + Buffer 内核 + abort/text-codec + console

**交付**

- `js/builtins/events.js`：`EventEmitter`（Node 语义子集，进内建表）。
- `js/internal/buffer-core.js`：`Uint8Array` 子类 + Node 20 公开 API 全覆盖口径
  （例外 `SlowBuffer`/`transcode`/`poolSize` 记差异表 §7.1）；`allocUnsafe`
  首版零初始化（ND-8）。NC0 只挂全局 `Buffer`。
- `js/internal/abort.js`：`AbortController`/`AbortSignal` WHATWG 对齐实现；
  `js/internal/text-codec.js`：自 `js/skynet.js` 内联 polyfill 迁入并补齐。
- `js/builtins/console.js`：自 `js/skynet.js:332-442` 迁入（映射 skynet 日志通道）。
- `js/bootstrap.js`：装配 `Buffer`/`console`/`AbortController`/`AbortSignal`/
  `TextEncoder`/`TextDecoder` 全局（§3 清单）。
- `test/unit/` 起步：Buffer/events/abort/text-codec 的纯逻辑用例（`node --test`
  直跑，Node 即真值）。

**验收**

- `node --test test/unit/` 通过；`make test` 全绿。
- 新增场景 `test/config-globals.json`（配对 `test/service/globals-main.js`）：§3 全局清单逐项存在性 + 非清单全局（`io`/
  `fetch`/`WebSocket` 等）不占名。

**提交拆分**：events / buffer-core / abort + text-codec / console 迁移 + bootstrap
装配 / unit 用例。

### NC0.7 现有库 require 化迁移（逐库提交）

按 §16.11 迁移映射与 NC0 过渡形态执行；**每迁一个库跑对应 config 场景**，保持绿：

| 顺序 | 库 | 去向 | 备注 |
|---|---|---|---|
| 1 | `js/cluster.js` | `js/builtins/skyjs/cluster.js` | 直接落最终位置 |
| 2 | `js/gateserver.js` | `js/builtins/skyjs/gateserver.js` | 同上 |
| 3 | `js/crypt.js` | `js/internal/crypt-core.js` + `js/builtins/skyjs/crypt.js` | 分层拆分 |
| 4 | `js/io.js` | `js/internal/fs-core.js`（雏形）+ `js/builtins/skyjs/fsx.js` | 同步改用 `skynetcore.fs.*` 新分组 |
| 5 | `js/http.js` | 过渡 CJS 内部件 | 不进内建表，测试服务相对路径引用 |
| 6 | `js/socket.js` + `js/sockethelper.js` | 过渡 CJS 内部件 | 同上 |
| 7 | `js/websocket.js` | 过渡 CJS 内部件 | 同上 |
| 8 | `js/skynet.js` | 拆为 bootstrap / event-loop / console / `skynet` 全局收窄 | `skynet.exit()` 语义收窄为退出当前 service |

同步迁移 `test/service/*.js` 与 `test/config-*.json`：服务入口改 require 形态
（`io-main.js` 等改 `require('skyjs/fsx')`，§16.10）。

**验收**：每库迁移后对应场景通过；全部迁完 `make test` 全绿。

**提交拆分**：每库一个提交（源码迁移 + 测试入口 + 配置）。

### NC0.8 NC0 收口

**任务**

- 删除 `snjs.c` 的 `lazy_setup_js` 固定表、`__snjs_lazy_paths` 与全部旧全局注入。
- 删除 `skynetcore` 旧扁平名双挂（含 `js/skyjs.d.ts` 同步）。
- `js/skyjs.d.ts` 开始拆到 `js/types/*.d.ts`（按模块维护，随各批补齐，§16.11）。
- `docs/HISTORY.md` 记录 NC0 完成。

**NC0 出口验收（§13 原文逐项）**

1. `make && make test` 全绿。
2. 现有 `test/config-*.json` 全部走 require 入口且不回归。
3. 纯定时器程序能自行推进（`config-timers`）。
4. `process.exit(3)` 以 3 退出宿主（`config-process-exit`）。
5. `globalThis` 只含 §3 清单 + `skynet`；旧全局（`io`/`http`/`socket`/
   `sockethelper`/`websocket`/`crypt`/`cluster`/`gateserver`）不再暴露。
6. `skynetcore` 只剩分组命名空间（`fs`/`net`/`seri`/`netpack`/`crypt`/`tls`/
   `runtime`）；`features()` 可用。

## 5. NC1 基础模块与错误层

### NC1.1 `internal/errors`

- Node errno/code 构造与映射表（§16.4.2 职责表：唯一错误来源）；C 侧错误码 →
  `err.code`/`errno`/`syscall`/`path` 的转换骨架（完整接入随 NC2.3）。
- 验收：`test/unit/errors.test.js`（Node 对拍错误字段形状）。

### NC1.2 纯 JS 模块 + 单测/对拍设施

- `js/builtins/path.js`/`util.js`/`url.js`/`querystring.js`/`os.js`（§13 NC1；
  `path`/`os` 数据源 `skynetcore.runtime.info()`）。
- `test/node-compat/` + `tools/run-node-compat.js`：同一用例在 Node 20 与 SkyJS
  双跑、逐项对比返回值（§16.10，这是"完整覆盖"承诺的验收依据）。
- 验收：`node --test test/unit/` 通过；node-compat 首批用例（path/querystring/
  url/util）双侧一致。

### NC1.3 `require('buffer')` + `Blob`/`File`

- `js/builtins/buffer.js` 包装 `internal/buffer-core`；补全局 `Blob`/`File`（§7.1
  全覆盖口径；`fs.openAsBlob` 的前置）。
- 验收：`require('buffer')` 与全局 `Buffer`/`Blob`/`File` 是同一实现（
  `test/config-buffer-entry.json`（配对 `test/service/buffer-entry-main.js`）+
  node-compat 用例）。

### NC1.4 `internal/binary-frame`

- `frameEncode`/`frameDecode`：长度前缀 + 二进制体的跨 service envelope（§15.2，
  取代 base64 RPC；js-seri 不能 round-trip `ArrayBuffer`）。
- 验收：unit 用例（往返、非法长度拒绝、空帧、分帧粘包）；一个 service 间传输
  `ArrayBuffer` 的场景验证零拷贝路径。

### NC1.5 基础 `node_modules` 查找

- 相对路径逐级向上查找、`package.json#main`、`index.js`/`index.json`；层 2 的
  `@skyjs/<name>` 回退（§3.1；单文件/目录解析规则 §9.2）。
- 验收：node-compat 场景覆盖裸包名、`@scope/name`、子路径、`package.json#main`、
  回退优先级（内建表先于文件系统）。

### NC1.6 `skyjs/log` + `skyjs/testing`

- `js/builtins/skyjs/log.js`（桥 `skynetcore.runtime.error`）与
  `js/builtins/skyjs/testing.js`（引擎自验证契约，[infra/11-testing.md](infra/11-testing.md)）。
- 验收：`test/config-*.json` 至少一个场景改用 `skyjs/testing` 断言输出。

**NC1 出口验收（§13 原文逐项）**：`node --test test/unit/` 通过；`path`/
`querystring`/`url`/`errors` 等用例在 Node 20 与 SkyJS 两侧对拍一致；
`node_modules` 查找四类覆盖；`require('buffer')` 与全局同一实现。

## 6. NC2 流与完整 `fs`

### NC2.1 `internal/stream-core` + `require('stream')`

- credit 流内核：可读/可写/pipe/取消/背压（§16.6）；`js/builtins/stream/index.js`
  适配出 `Readable`/`Writable`/`Duplex`/`Transform`/`pipeline`；
  `stream/promises` 同批（`pipeline`/`finished`）。
- 验收：node-compat stream 常用行为用例（事件顺序、背压、错误传播、取消）。

### NC2.2 `internal/permission` + `.fs` owner + 二进制通道

- `js/internal/permission.js`：路径边界/配额/能力授权的纯逻辑判定（§15.2；
  `.fs`/`.subprocess` owner 与插件宿主共用）；拒绝映射 `EACCES`/`EPERM`。
- `service/fs-service.js`（`.fs` owner service，首个 `service/` 文件）:RPC 走
  `internal/binary-frame` envelope；`js/ioservice.js` 同批删除。
- 验收：权限拒绝用例（越界路径/超配额）+ 大块二进制 RPC 不走 base64。

### NC2.3 `js-io.c` → `js-fs.c` 重构 + 原语扩展

- 更名并补 fd/errno/权限/流式原语（§16.11）：`ftruncate`/`fsync`/`fdatasync`/
  `realpath`/`chmod`/`fchmod`/`fchown`/`futimes`/`symlink`/`readlink`/`mkstemp`/
  `statvfs`/`readv`/`writev`；`watch` 的原生 watcher 线程（macOS kqueue
  `EVFILT_VNODE`，事件经 skynet 消息注入 `.fs` owner，ND-36）。
- C 错误结构化：`errno`+`syscall`+`path`（NC1.1 骨架在此完整接入）。
- 验收：unit 层错误映射对拍；`test/node-compat/fs-errors` 常见 errno 一致。

### NC2.4 完整 `fs` facade + `skyjs/fsx`

- `js/builtins/fs/`：`index.js`（callback）/`promises.js`/`handle.js`（FileHandle）/
  `streams.js`（createReadStream/createWriteStream）/`watcher.js`（watch/
  watchFile/FSWatcher/StatWatcher）/`constants.js`；`Stats`/`Dirent`。
- `js/internal/fs-core.js` 成形；`js/builtins/skyjs/fsx.js` 与 `fs` 共用内核与
  `.fs` owner（ND-11/ND-12）。
- **硬规则：callback/sync/Promise 三种形态与流式/watch 一次交付，不允许只交
  `fs/promises`**（§13 NC2、§8.1）。

### NC2.5 出口专项验收

- Node 20 `fs` 公开 API 逐项对照（`test/node-compat/` 逐 API 用例）。
- 1 GiB 流经 `pipe` 时 JS 堆增量 < 64 MB（`skynetcore.runtime.mem()` 计量）。
- 权限拒绝与取消后 fd 无泄漏（owner 侧 fd 计数断言）。

## 7. NC3 子进程

- **NC3.1** `service-src/js-subprocess.c`：`spawn`/`wait`/`kill`/管道
  read/write/close 原语（[infra/06-subprocess.md](infra/06-subprocess.md)；`SUBPROCESS=1` 编入开关）。
- **NC3.2** `service/subprocess-service.js`（`.subprocess` owner）+
  `js/internal/subprocess-core.js`：独占进程句柄、stdio 读循环、并发配额、取消/
  超时后 kill 与孤儿回收。
- **NC3.3** `js/builtins/child_process.js` facade（`spawn`/`exec`/`execFile`/`kill`，
  `fork` 后置，§10.2）；移动端不编入，`features().subprocess.available === false`。

**出口**：`spawn`/`exec`/`execFile` 的 stdio、退出码/signal、超时与取消对拍
Node；取消后无孤儿进程；移动端构建验证开关。

## 8. NC4 网络、HTTP 与密码学

- **NC4.1** `internal/net-core.js`：合并 `js/socket.js` + `js/sockethelper.js`
  （连接生命周期、缓冲、背压）；**删除 socket/sockethelper 过渡件**；`httpc`
  旧全局移除。
- **NC4.2** `js/builtins/net.js`（`Socket`/`Server`/`connect`/`listen`/`timeout`，
  含"服务保活 + 事件泵"适配层，§15.4）与 `js/builtins/tls.js`。
- **NC4.3** `internal/http-core.js`（原 `httpInternal` 抽出）+
  `js/builtins/http.js`/`https.js`（`createServer`/`Server`/`IncomingMessage`/
  `ServerResponse`/`request`，流语义与 keep-alive）+ `js/builtins/fetch.js` 装载件
  挂全局 `fetch`；**删除 http 过渡件**。
- **NC4.4** `internal/crypt-core.js`（抽自 `js/crypt.js`）+
  `js/builtins/crypto.js`/`zlib.js`（zlib 压缩原语补入 `skynetcore.crypt` 或
  独立 C 模块）。
- **NC4.5** 网络收口：全局清单复核（`fetch` 加入，`httpc` 移除）、长跑稳定性
  （keep-alive 与断连取消的 fd/内存）。

**出口**：`http` server/client 常用子集对拍 Node；`fetch` 经同一内核实现且不暴露
`httpc`；长跑 fd/内存稳定。

## 9. NC5 第三方 C 桥装载（可选，非首版门禁）

- **NC5.1** `service-src/js-native.c`：`skynetcore.native.enabled/dynamicEnabled/
  staticEnabled/resolve/find/load/abi/init/initStatic/unload/errmsg`（§3.4.5）。
- **NC5.2** `js/internal/native-loader.js` + `extpath` 配置键 +
  `package.json#skyjs.native`（字符串或平台键值表）解析。
- **NC5.3** 静态构建符号改写 + 构建期生成 `native-registry.c`（不入库）+ 示例
  扩展 `@skyjs/example-native` 动态装载验收。

## 10. 包批次（NC2 后持续）

依赖的公开面就绪即可逐个搬出（§16.12 顺序 8），内建表不收录，loader 按 §3.1
回退 `node_modules/@skyjs/<name>`：

| 包 | 依赖公开面 | 触发时机 |
|---|---|---|
| `@skyjs/websocket` | `http`/`net`/`stream` | NC4.2 后；落地后**删除 websocket 过渡件** |
| `@skyjs/webapp` | `http`/`net`/`stream` | NC4.3 后 |
| `@skyjs/archive` | `fs`/`stream` | NC2 后 |
| `@skyjs/config` / `@skyjs/metrics` | 层 1/层 2 入口 | NC1 后即可 |
| `@skyjs/db` | 二进制通道、owner 形态 | NC2.2 后（[infra/03-sqlite.md](infra/03-sqlite.md)） |
| `@skyjs/media` / `@skyjs/tag` | `fs`/`db`/包内 C 桥 | 独立大线（[infra/08-media-tag.md](infra/08-media-tag.md)），不排 NC 批次 |

收口标准：**删掉 `packages/` 整个目录后，引擎仍能构建、启动、跑通层 1 模块与 8 个
内建入口的自验证用例**（§16.4.1）。

## 11. 横切事项

### 11.1 文件级落位核对表

`js/internal/` 16 个文件的批次归属（与 §16.4.2 逐文件表一致）：

| 批次 | 文件 |
|---|---|
| NC0 | `event-loop` `abort` `text-codec` `buffer-core` `module-registry` `path-posix` |
| NC1 | `errors` `binary-frame` |
| NC2 | `stream-core` `fs-core` `permission` |
| NC3 | `subprocess-core` |
| NC4 | `net-core` `http-core` `crypt-core` |
| NC5 | `native-loader` |

`js/builtins/` 19 个 Node 面 + 8 个 `skyjs/*` 的批次归属：

| 批次 | Node 面入口 | skyjs 内建 |
|---|---|---|
| NC0 | `events` `console` | `cluster` `gateserver` `crypt` `fsx`（雏形） |
| NC1 | `path` `util` `url` `querystring` `os` `buffer` | `log` `testing` |
| NC2 | `fs` `fs/promises` `stream` `stream/promises` | `fsx`（成形） |
| NC3 | `child_process` | `subprocess` |
| NC4 | `net` `http` `https` `tls` `crypto` `zlib`（`fetch` 为装载件） | — |
| 插件宿主线 | — | `pluginHost`（[infra/09-plugin-host.md](infra/09-plugin-host.md) 独立线） |

### 11.2 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| loader 正确性（循环引用/缓存/局部性） | 全部后续批次的地基 | NC0.2 验收先行 + unit 化；NC1.5 再对拍 Node 解析 |
| 事件循环顺序（nextTick/microtask/immediate/timer） | 定时器、流、网络全部假设它 | NC0.4 三组顺序断言固定；后续每批回归 |
| `process.exit` 哨兵被用户 catch | 退出语义与 Node 差异 | 按 §4.1 已知差异处理，记 §12 差异表，按退出码验收 |
| 双挂过渡遗漏旧名 | NC0.8 删名时破绿 | NC0.3 起维护旧名调用点清单，删名前 grep 清零 |
| fs 大文件内存 | 1 GiB pipe 门禁 | binary-frame 先行（NC1.4），禁止 base64 兜底 |
| 字节码打包 | 发布模式 | 不阻塞 NC0；`jsModuleSource` 双模式自 NC0.1 预留，[infra/13-build-ci.md](infra/13-build-ci.md) §13.2 收口 |

### 11.3 文档同步

- 每子批完成：`docs/HISTORY.md` 一条；本文 §3 状态表更新。
- 发现语义/架构偏差：先修 `node-compatibility.md`（基线），再修本文。
- 包批次启动时：对应 `infra/<nn>.md` 契约文档先行核对。

## 12. 里程碑

| 里程碑 | 判定 |
|---|---|
| M0 = NC0 出口 | §4 NC0.8 六项验收全过；模块系统/事件循环可用 |
| M1 = NC1 出口（决策门 1 前置） | node-compat 双跑设施就绪，纯 JS 面对拍一致 |
| M2 = NC2 出口 | **首版发布门禁达标**：完整 `fs` + stream 对拍通过、内存/fd 专项通过 |
| M3 = NC3/NC4 出口 | 网络/子进程/密码学常用子集对拍 Node，长跑稳定 |
| 决策门 1（[infra/15-roadmap-estimates.md](infra/15-roadmap-estimates.md)） | NC1 出口评估模块系统/事件循环达标；未达标暂停后续批次 |
