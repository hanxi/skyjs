# 01 — 命名与通用契约（规范）

本文件是**命名总表与通用契约的唯一定义处**。其它文档只引用本文，不重复定义。

## 1. 标识符与文件命名

- JS 标识符一律 `lowerCamelCase`（类 `UpperCamelCase`、常量 `UPPER_SNAKE_CASE`）。
  项目目标为兼容 Node 代码（LLRT 路线），命名对齐 JS 生态惯例；C 源码内部命名
  （`js_*`/`snjs_*`）保持 C 规范不变。
- **冻结域**（字符串字面量逐字保留）：env/config 键（`jsBootstrap`、`jsModuleRoot`、
  `jsModuleSource`、`extpath`、`cpath`、`jsMemLimit`、`__json_config`…）；线协议与命令串（skynet 命令、cluster 帧）；测试验收标记串。
  算子/架构域名词白名单：`iso7816_4`、`x86_64` 等保留原名。
- **Node 规范名是外部契约**：`child_process`、`fs/promises`、`http` 等模块名与
  `AbortSignal` 等全局名逐字沿用 Node，不套用本项目 camelCase 规则。
- 禁 `var`。库以 CommonJS 模块组织，经 `require` 显式依赖；只有 Node 规范全局与
  `skynet` 保留在 `globalThis`，`__snjs_*` 仅作为 C 契约保留。
- 文件命名：
  - 引导与 loader：`js/bootstrap.js`、`js/loader.js`。
  - 私有能力内核：`js/internal/<name>-core.js`（无稳定契约，可自由重构）。
  - Node 面模块：`js/builtins/<node-name>.js`（名字逐字沿用 Node 规范）。
    目录形式（`js/builtins/fs/`、`js/builtins/stream/`）用于有子入口或多文件的模块，
    入口仍为 `index.js`；`<node-name>.js` 用于单文件模块。
  - SkyJS 规范入口的**引擎内建**实现（仅 8 个，见 §3）：`js/builtins/skyjs/<name>.js`
    （单文件）或 `js/builtins/skyjs/<name>/index.js`（多文件），经
    `require('skyjs/<name>')` 引用。
  - SkyJS 规范入口的**包**实现：`packages/<name>/`，发布为 `@skyjs/<name>`，多文件
    用目录形式（`index.js` + 子文件）；loader 在内建表未收录时回退
    `node_modules/@skyjs/<name>`（§3）。
    `media`/`tag`/`webapp`/`db`/`archive`/`websocket`/`config`/`metrics` 属于此类。
  - 类型声明：`js/types/<module>.d.ts`。
  - owner service：内建能力放 `service/<cap>-service.js`（如 `fs-service.js`）；
    包能力随包放 `packages/<name>/service/<cap>-service.js`。
  - C 源：引擎原语 `service-src/js-<cap>.c`（C++ 适配用 `.cc`）；包自带原生实现
    `packages/<name>/native/src/*.c`（C++ 用 `.cc`），不写进 `service-src/`。
  - 文档：`docs/infra/NN-topic.md`。

### 1.1 外部兼容面豁免（唯一例外）

`lowerCamelCase` 约束适用于**本项目自有**的库与注入名。以下属于**外部既定契约**，
必须逐字沿用对方命名，不得改写：

| 面 | 命名风格 | 原因 |
|---|---|---|
| 插件 bridge（`songloft.*`、`onHTTPRequest` 等，见 09） | camelCase | 现有插件源码直接调用，改名即破坏兼容 |
| Android JNI / Java 侧（`isRunning`/`getPort`，见 12） | camelCase | Java 语言惯例与宿主客户端约定 |
| Web 标准 API（`AbortSignal`、`TextDecoder`、`ArrayBuffer`…） | 标准原名 | 与 WHATWG/ECMA 对齐 |
| HTTP header 名 | 协议原名 | 线协议 |

移动端 C ABI 仍用 snake_case（`skyjs_start` 等），camelCase 只出现在 Java/Swift 包装层。

## 2. 四层结构与命名映射

| 层 | 形态 | 职责 |
|---|---|---|
| L4 公开面 | `require('<node-module>')`（引擎内建）、`require('skyjs/<name>')`（引擎内建或 `@skyjs` 包）、Node 规范全局 + `skynet` | 业务与插件可见的稳定 API |
| L3 能力内核 | `js/internal/<name>-core.js` | 私有、可重构的解析/流控/连接/错误等共享逻辑，被多个 facade 复用；**仅引擎内建 facade 可用**，包不得 require |
| L2 owner service | 引擎 `service/<cap>-service.js`；包 `packages/<name>/service/<cap>-service.js`，注册名均 `.<cap>` | 独占原生资源、串行化访问、取消与清理 |
| L1 C 原语 | 引擎 `skynetcore.<ns>.*`（`service-src/js-<cap>.c`）；包内 C 桥（`packages/<name>/native/src/*`，挂 `module.native`） | 同步、非阻塞的原生绑定 |

依赖方向单向：L4 → L3 → L2 → L1。两个 L4 facade 之间不得互相依赖；共享逻辑必须下沉
到 L3。`js/internal/*` 不对外暴露，不承诺稳定契约。

**引擎层与 `@skyjs` 包层**：引擎只内建运行时底座、Node 兼容面与 8 个承重
`skyjs/*` 入口；领域能力一律落 `packages/<name>/`，发布为 `@skyjs/<name>`。包只依赖
L4 公开面，不得 `require('js/internal/*')`、不得直接调用 `skynetcore.*`。判据、
引擎目录与包布局见 [../node-compatibility.md](../node-compatibility.md) §16.4。

## 3. 能力命名总表

| 能力 | 归层 | 公开入口 | L3 内核 | C 注入 | owner service | C 源 |
|---|---|---|---|---|---|---|
| 核心运行时 | 引擎 | `skynet`(全局扩展)、`require('stream')`、`require('buffer')` | `internal/event-loop`、`internal/stream-core`、`internal/buffer-core` | `skynetcore.runtime` | 无（进程内） | `snjs.c` |
| 系统信息 | 引擎 | `require('os')` | 复用 | `skynetcore.runtime.info` | 无 | 复用 |
| HTTP 客户端 | 引擎 | `require('http')` / `require('https')` | `internal/http-core`、`internal/net-core` | `skynetcore.net`、`skynetcore.tls` | 无 | 复用 |
| 文件（Node 面） | 引擎 | `require('fs')` / `require('fs/promises')` | `internal/fs-core` | `skynetcore.fs` | `.fs` | `js-fs.c` |
| 文件（自有流式） | 引擎 | `require('skyjs/fsx')` | `internal/fs-core` | `skynetcore.fs` | `.fs` | `js-fs.c` |
| 子进程 | 引擎 | `require('child_process')` / `require('skyjs/subprocess')` | `internal/stream-core` | `skynetcore.subprocess` | `.subprocess` | `js-subprocess.c` |
| 密码学 | 引擎 | `require('crypto')` / `require('skyjs/crypt')` | `internal/crypt-core` | `skynetcore.crypt` | 无（同步原语） | `js-crypto.c` |
| 压缩 | 引擎 | `require('zlib')` | `internal/crypt-core` | `skynetcore.crypt` | 无 | `js-crypto.c` |
| 网络 | 引擎 | `require('net')` | `internal/net-core` | `skynetcore.net` | 无 | `js-net.c` |
| TLS | 引擎 | `require('tls')` | `internal/net-core` | `skynetcore.tls` | 无 | `js-tls.c` |
| 日志 | 引擎 | `require('skyjs/log')` | `internal/errors` | `skynetcore.runtime.error` | 无（可选 `.log-sink`） | 复用 |
| 测试 | 引擎 | `require('skyjs/testing')` | 复用 | 无 | 无 | 无 |
| 插件宿主 | 引擎 | `require('skyjs/pluginHost')` | 受限白名单 | 无 | `.pluginManager` | `snplugin` loader |
| 集群 | 引擎 | `require('skyjs/cluster')` / `require('skyjs/gateserver')` | 复用 | `skynetcore.runtime` | 无 | 复用 |
| 第三方 C 桥 | 引擎 | 由扩展包提供，入口随包 | 无（loader 直接注入 `module.native`） | `skynetcore.native`（无公开入口，约定仅 loader 调用） | 无 | `js-native.c` |
| HTTP 应用 | 包 | `require('skyjs/webapp')` | 无（只用公开 `http`/`net`/`stream`） | 无 | 无 | 无 |
| WebSocket | 包 | `require('skyjs/websocket')` | 无（同上） | 无 | 无 | 无 |
| 归档 | 包 | `require('skyjs/archive')` | 无 | 无（纯 JS；可选 `module.native`） | 无 | 包内 `native/src`（可选） |
| 配置 | 包 | `require('skyjs/config')` | 无 | 无（经公开 `skyjs/db`、`skyjs/log`） | `.config`（可选） | 复用 |
| 指标 | 包 | `require('skyjs/metrics')` | 无 | 无（经公开 `skyjs/log`） | `.metrics`（可选） | 复用 |
| SQLite | 包 | `require('skyjs/db')` | 无 | 包内 C 桥 → `module.native` | `.sqlite` | 包内 `native/src/js-sqlite.c` |
| 媒体 | 包 | `require('skyjs/media')` | 无 | 包内 C 桥 → `module.native` | `.media` | 包内 `native/src/js-media.c` |
| 标签 | 包 | `require('skyjs/tag')` | 无 | 包内 C 桥 → `module.native` | 复用 `.media` 或 `.tag` | 包内 `native/src/js-tag.cc` |

owner service 是否常驻/懒启由各库文档定义；无 owner 的库（如 `webapp`/`stream`/
`crypt`/`testing`）在调用方服务内直接运行。“归层”列是 §16.4.1 判据的落地结果：
引擎行落 `js/builtins/` 与 `service/`/`service-src/`；包行落 `packages/<name>/`。
`js/builtins/skyjs/*` 只承载引擎内建的 8 个入口，`js/builtins/*` 根下的名字必须与
Node 规范一致。

表中未单列的 `js/bootstrap.js`、`js/loader.js`、`js/internal/module-registry.js` 是
引擎自举件，不是任何能力的所有者，因此不进本表（它们在 node-compatibility §16.4.2
登记，并给出引擎逐文件清单）。引擎行与包行的判据只有一条：删掉 `packages/` 后
引擎是否仍能构建启动（§16.4.1）；命中判据的进上表引擎行，其余一律包行。包侧的
逐包实现清单与字段级落位见 §16.4.3.1。

**模块归属（三层，解析优先级内建表先于文件系统）**：

| 层 | 入口 | 实现来源（按序） | 解析 |
|---|---|---|---|
| 1 Node 内建 | `fs`/`stream`/`http`/`events`… | 仅 `js/builtins/<node-name>` | 内建表 |
| 2 SkyJS 规范入口 | `skyjs/<name>[/<subpath>]` | ① 内建 `js/builtins/skyjs/<name>`；② `node_modules/@skyjs/<name>` | 内建表优先，未收录回退文件系统 |
| 3 用户与第三方 | 裸包名、相对/绝对路径 | `node_modules/**` 与工程目录 | 文件系统 |

层 2 的 16 个名字**归层已定死**（node-compatibility §16.4.1）：8 个承重入口内建，
8 个领域能力走 `@skyjs/<name>` 包。内建表只收录前者；后者删掉 `packages/` 后
引擎照常构建启动。`skyjs/*` 是保留的说明符命名空间，第三方包不得占用。

原生部分有两种接入形态，不要混用：

- **长驻、需 Actor 隔离** → cservice（`.media` 这类 owner），包可携带预编译 `.so`
  （cpath 可指向 `node_modules`）、静态库或 C/C++ 源码（构建期编译）。
- **只要一个同步 C 函数** → C 桥模块（`register_openssl_crypto` 那种手写
  `JS_NewCFunction`）：首方能力编进 `snjs.so`，第三方包导出
  `skyjs_ext_abi` / `skyjs_ext_init`，经 `package.json#skyjs.native`（`extpath`
  非空时动态装载）或构建期静态链入。

判定规则、原生形态与 ABI 校验详见
[../node-compatibility.md](../node-compatibility.md) §3.1–3.4。
### 3.1 `globalThis` 白名单

只保留 Node 规范要求的全局与 `skynet`：

```text
module / exports / require / __filename / __dirname   # 模块作用域，非 globalThis
global / process / Buffer / Blob / File / console
setTimeout / clearTimeout / setInterval / clearInterval
setImmediate / clearImmediate / queueMicrotask
URL / URLSearchParams / AbortController / AbortSignal
TextEncoder / TextDecoder
skynet                                                # Actor 运行时入口契约
```

`fetch`/`WebSocket`/`structuredClone` 等在对应模块落地后再加入全局，不提前占名。
`Blob`/`File` 是 `fs.openAsBlob()` 的返回类型依赖，须与 `require('buffer')`
（NC1）同批落地，不能延后到 NC4。

### 3.2 现状迁移映射

本节描述的是**重构前状态**，目标形态以上表与
[../node-compatibility.md](../node-compatibility.md) §16 为准：

| 现状 | 目标 |
|---|---|
| `globalThis.io`（`js/io.js`） | `require('skyjs/fsx')`（自有）+ `require('fs')`（Node），共享 `js/internal/fs-core.js` |
| `globalThis.httpd`/`httpc`/`httpInternal` | `require('skyjs/webapp')` / `require('http')` / `require('https')`，协议内核下沉 `js/internal/http-core.js` |
| `globalThis.websocket` | `require('skyjs/websocket')` |
| `globalThis.crypt` | `require('skyjs/crypt')` / `require('crypto')`，共享 `js/internal/crypt-core.js` |
| `globalThis.cluster`/`gateserver` | `require('skyjs/cluster')` / `require('skyjs/gateserver')` |
| `globalThis.socket`/`sockethelper` | 收进 `js/internal/net-core.js`，不对外暴露 |
| `globalThis.stream`（规划态） | `require('stream')`（Node 面）+ `js/internal/stream-core.js`（共享内核） |
| `globalThis.db`/`media`/`tag`/`config`/`log`/`metrics`/`testing`/`pluginHost`/`subprocess` | `require('skyjs/<name>')` |
| `js/ioservice.js` + base64 RPC | 删除；能力并入 `service/fs-service.js`，RPC 走二进制 envelope |
| `snjs.c` `lazy_setup_js` 固定表 | 删除；改为 `js/loader.js` + `js/bootstrap.js` + 构建期模块清单 |
| env 键 `jsLoader`/`jsSocket`/`jsCrypt`/… 每库一键 | 收敛为 `jsBootstrap`/`jsModuleRoot`/`jsModuleSource`（+ 原生产物的 `cpath`/`extpath`），新增模块不再改 C |
| `service-src/js-io.c` | 重构为 `js-fs.c`，注入命名空间改为 `skynetcore.fs` |

### 3.3 协议串冻结范围

仅 **skynet 命令与 cluster 帧** 属冻结域：前者是零修改 `3rd/skynet` 内核
`skynet_command()` 的入参，后者是与原版节点互通的线协议字节，两者都不由本项目决定。
tls `"client"`/`"server"` 不设冻结——它只是 `js-tls.c` 的 C↔JS 内部参数串，
由"JS/C 同步改名"的一般规则约束；HTTP/WS 协议常量（header 名、握手 GUID 等）
不设冻结——它们是 RFC 7230/6455 定义的标准格式（header 名线上大小写不敏感），
照规范实现即可。
**`js/io.js` ↔ `js/ioservice.js` 的旧 RPC op 串（`"read_file"` 等）同样不是冻结域**：
`.fs` owner 随重构新建，直接采用 `op: "stat" | "open" | "read" | …` 的清晰枚举，
不续用旧扁平字符串表。旧的 `io`/`ioservice` 入口一并移除。

## 4. 错误契约

- 所有异步 API 失败时 `reject(Error)`；同步 API `throw Error`。
- `Error` 附带：
  - `err.code`：字符串枚举（见下）。
  - `err.detail`：可选，结构化补充（原生错误码、路径、statement 等，脱敏后）。
- **Node facade 例外**：`require('fs')`/`require('net')` 等 Node 面模块必须优先暴露
  Node 语义字段（`err.code`/`err.errno`/`err.syscall`/`err.path`），SkyJS 分类放在
  `err.detail.skyjsCode`，不得用 `ERR_*` 覆盖 `err.code`。详见
  [../node-compatibility.md](../node-compatibility.md) §6。
- 核心错误码枚举（跨库统一）：

| code | 含义 |
|---|---|
| `ERR_CANCELLED` | 被 `AbortSignal`/取消触发中止 |
| `ERR_TIMEOUT` | 超过 deadline |
| `ERR_UNSUPPORTED_PLATFORM` | 当前平台不提供该能力 |
| `ERR_PERMISSION` | 权限/沙箱拒绝 |
| `ERR_LIMIT_EXCEEDED` | 超过大小/数量/配额上限 |
| `ERR_NOT_FOUND` | 目标不存在 |
| `ERR_BUSY` | 资源忙/锁冲突（如 SQLITE_BUSY） |
| `ERR_PROTOCOL` | 协议/格式非法 |
| `ERR_IO` | 底层 I/O 失败 |
| `ERR_INTERNAL` | 未归类的内部错误 |

各库可定义带前缀的子码（如 `ERR_DB_CONSTRAINT`、`ERR_HTTP_HEADER_TOO_LARGE`），
但必须能归并到上表之一（通过 `err.code` 前缀或 `err.detail.class`）。

## 5. 能力探测

新增 `skynet.features() -> object`，返回当前运行时的能力表，例如：

```js
{
  version: "0.2.0",
  sqlite:        { available: true,  version: "3.46.0" },
  httpStream:   { available: true },
  fsAsync:      { available: true },
  archive:       { available: true },
  subprocess:    { available: false, reason: "ERR_UNSUPPORTED_PLATFORM" },
  media:         { available: true,  backend: "libav", codecs: ["mp3","aac","flac"] },
  tag:           { available: true,  backend: "taglib" },
  cryptExt:     { available: true },
  nativeExt:    { available: true,  dynamic: false, static: true },
  pluginSandbox:{ available: true }
}
```

- 不支持的能力：`available: false` 且 `reason` 为对应错误码；对应库调用抛该码。
- `nativeExt` 对应当前构建的第三方 C 桥装载能力：`available` 即编入了
  `NATIVE_EXT=1`（`skynetcore.native.enabled()`），`dynamic`/`static` 分别来自
  `skynetcore.native.dynamicEnabled()`（`extpath` 非空）与
  `skynetcore.native.staticEnabled()`（静态表非空），表示两条装载路径是否可用
  （node-compatibility §3.4.5）。单个扩展包的能力键由 loader 装载成功后登记，键名用包的完整名字，
  值至少含 `{ available, abi }`。
- 每个公开模块额外暴露 `version`（字符串常量），用于跨版本诊断。Node facade 的
  `version` 报告对标的 Node 版本（`20.x`），SkyJS 自身版本以
  `skynet.features().version` 为准。

## 6. 取消与超时通用契约

- 统一用 `AbortSignal`（QuickJS-ng 不内置，由 `js/internal/abort.js` 提供 polyfill，
  语义与 WHATWG 对齐：`signal.aborted`、`signal.reason`、
  `addEventListener('abort')`）。
- `TextEncoder`/`TextDecoder` 同样不内置，由 `js/internal/text-codec.js` 提供；两者
  在 NC0 随全局装配一起落地，后续模块不允许再各自内联编解码实现。
- 约定：任何可能长耗时的 API 接受可选 `{ signal, timeoutMs }`：
  - `signal` 触发 → `reject(ERR_CANCELLED)`，并向下游（DB/进程/媒体/流）传播取消。
  - `timeoutMs` 到期 → `reject(ERR_TIMEOUT)`，同样触发下游中止。
- owner service 侧：收到取消后必须尽快释放原生资源（statement、fd、子进程、libav ctx）。
- late response（请求已取消但响应姗姗来迟）必须被 `skynet` 扩展层丢弃，不得错配
  （详见 02-core-runtime）。

## 7. 二进制与大数据契约

- service 间大块二进制统一用 `ArrayBuffer` 直传（不经 base64、不经 lua-seri 大 Map）。
- 需要分片流式时用 `js/internal/stream-core.js` 的 chunk 协议（credit-based，见 02）；
  Node `stream` facade 与 `skyjs/*` 各自适配这一内核。
- 整数：跨边界的 64 位整数用 `BigInt`；对外 JSON 序列化时，超过
  `Number.MAX_SAFE_INTEGER` 的值显式转字符串（各库在文档内标注具体字段）。

## 8. 版本与稳定性

- 文档族版本随 `skynet.features().version` 对齐。
- 接口标注稳定级别：`stable` / `experimental` / `internal`；`internal`（如
  `js/internal/*`、`skynetcore.runtime.readModuleSource`、`__snjs_*`）不对业务/插件暴露。
- 破坏性变更须同步更新本表、对应库文档，并按 [../DEVELOPMENT.md](../DEVELOPMENT.md)
  的三处文档同步约定处理。
