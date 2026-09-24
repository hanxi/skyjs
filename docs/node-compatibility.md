# SkyJS Node.js 兼容层

状态：已确认的实施基线（架构基线见 §16，决策记录见 §14）  
目标版本：Node.js 20 LTS 的常用稳定子集  
关联文档：[infra/README.md](infra/README.md)、[infra/00-overview.md](infra/00-overview.md)、
[infra/01-conventions.md](infra/01-conventions.md)、[infra/02-core-runtime.md](infra/02-core-runtime.md)

## 1. 兼容目标

SkyJS 的 Node.js 兼容层定位为 **Node 常用 API 的适配层**，不是完整 Node.js 运行时。
目标是让常见 Node 服务端代码在少量修改后运行于 SkyJS Actor 环境中，同时保留
SkyJS 的进程模型、隔离能力、资源配额与生命周期管理。

兼容优先级：

1. **语义近似**：对常用 Node API 提供与 Node 20 LTS 一致或明确记录差异的语义。
2. **Actor 隔离**：兼容层不能破坏单服务内存、调度、取消与清理边界。
3. **资源安全**：文件、子进程、网络等能力必须经过 SkyJS 权限与配额约束。
4. **可控范围**：不承诺完整 Node/npm 生态兼容，不引入不受控的宿主级能力。

## 2. 明确范围

### 2.1 初始范围

- 仅支持 CommonJS 模块加载；ESM 不在本阶段实现。
- 基础版 `node_modules` 查找：裸包名、`@scope/name`、子路径、`package.json#main`。
- SkyJS 一方模块既可作为运行期内建实现，也可作为 npm 包（`@skyjs/<name>`）分发；
  公开入口统一为 `skyjs/<name>`（§3.1）。
- 原生模块支持 C 编译产物：cservice `.so`（cpath 动态加载，搜索路径可指向
  `node_modules`）、静态库，以及随包发布的 C/C++ 源码（由应用构建期编译，§3.2）；
  JS 直接调 C 的 C 桥模块同样可按 `package.json#skyjs.native` 动态或静态装载（§3.4）。
- 完整 `fs` / `fs/promises`：Node 20 公开 API 全覆盖，首版必须交付。
- 常用全局对象：`process`、`Buffer`、`Blob`、`File`、`console`、`global`；完整清单以
  §3 的注入清单为准。
- 常用定时器：`setTimeout`、`setInterval`、`setImmediate`、`queueMicrotask`、`process.nextTick`。
- 常用内置模块：`events`、`util`、`path`、`url`、`querystring`、`buffer`、`os`。
- 基础错误语义：Node 常见 `code`、`errno`、`syscall`、`path` 等字段。
- 与 SkyJS 基建的桥接：`stream`、`net`、`tls`、`child_process`、`crypto`、`zlib`、
  `http`、`https`；`fetch` 以全局形式提供。
- C 桥模块（JS 直接调用 C，`register_*` 模式）：**可选能力，不在首版门禁内**；
  形态、装载方式与安全边界见 §3.4。通用 FFI 明确不做（§3.5）。

### 2.2 非目标

- 除本文件明确列入初始范围的模块外，不承诺完整 Node.js 标准库。
- 完整 npm 生态；任意 native addon。SkyJS 只支持 §3.2 的三种原生集成形态，
  不兼容 Node N-API / node-gyp 式 addon。
- 免编译的通用 FFI：不提供签名驱动的任意 `.so` 调用；接 C 代码须经 §3.4 的
  C 桥模块显式包装。
- V8 内部 API、`vm` 语义、worker_threads 与 cluster。
- 进程级全局 signal handler。
- 绕过 SkyJS 权限模型获取宿主级能力；`process.exit()` 的宿主退出语义在核心决策中定义。
- 精确复刻 libuv 事件循环的所有阶段语义。

## 3. 暴露面与加载方式

**决策：不引入 `nodeCompat` 配置。**

Node 兼容面作为服务运行时的基础能力，由 loader 默认注入。受限插件 VM 仍按
manifest 与白名单决定实际可见的 Node 全局对象和内置模块。

普通服务中注入：

```js
module, exports, require, __filename, __dirname
global, process, console, Buffer, Blob, File
setTimeout, clearTimeout, setInterval, clearInterval
setImmediate, clearImmediate, queueMicrotask
URL, URLSearchParams
AbortController, AbortSignal
TextEncoder, TextDecoder
```

`require` 必须保持模块局部变量，不提升为全局变量。`console` 由 `builtins/console.js`
提供（映射 skynet 日志通道，实现自 `js/skynet.js` 迁入），`bootstrap` require 后挂
`globalThis.console`。`Buffer` 全局 NC0 落地，`Blob`/`File` 全局随 NC1 的
`require('buffer')` 入口补齐（§13）。

首批全局对象以 Node 20 规范名为准；`fetch`、`WebSocket`、`structuredClone` 等在对应
模块落地后再加入全局，不提前占名。`globalThis` 只保留本表与 `skynet`，其余能力一律
`require`。

引导不走 C 侧逐库懒加载。自举顺序固定为：C 侧注册 `skynetcore` 原生桥、创建
`process` 与 `skynet`，以**非模块脚本**装载 `js/loader.js`（loader 是模块系统本体，
不能经 `require` 加载自身），再由 loader `require('js/bootstrap.js')`；bootstrap
以普通模块身份运行：注册内置模块表、装配上表全局对象、require 服务入口。
模块 id 到实现的映射固定为（唯一定义处是
`js/internal/module-registry.js`）。映射按规则，而不是逐条硬编码：

| 模块 id 形式 | 实现位置 | 实例 |
|---|---|---|
| 单文件 Node 模块 | `js/builtins/<name>.js` | `buffer`、`events`、`path` |
| 多文件 Node 模块 | `js/builtins/<name>/index.js` | `fs`、`stream` |
| 子路径入口 | `js/builtins/<name>/<subpath>.js` | `fs/promises`、`stream/promises` |
| SkyJS 规范入口 | 引擎内建 `js/builtins/skyjs/<name>.js`（8 个，§16.4.1），或 `node_modules/@skyjs/<name>` | `skyjs/fsx`（内建）；`skyjs/media`、`skyjs/webapp` 等走 `@skyjs` 包 |
| 私有内核 | `js/internal/*` | 仅 L3 内部可 `require`，业务与插件请求一律 `ERR_PERMISSION` |

`node:` 前缀只是同一张表的别名，不构成第二套实现。`skynet.features()` 的返回结构
定义在 [infra/01-conventions.md](infra/01-conventions.md) §5，模块清单的构建期
收录见 §16.9。

### 3.1 模块归属：三层与解析顺序

`skyjs/*` 是**保留的模块说明符命名空间**，不是“实现必须留在运行体内”的声明。
`skyjs/media` 这类入口的实现既可以随运行时内建发行，也可以由 npm 包
`@skyjs/media` 提供，两者共用同一个 `require('skyjs/media')` 调用形式。

解析顺序固定为**内建表先于文件系统**：

| 层 | 说明符 | 实现来源（按序查找） | 解析 |
|---|---|---|---|
| 1 Node 内建 | `fs`/`stream`/`http`/`events`… | 仅 `js/builtins/<node-name>` | 内建表，先于文件系统 |
| 2 SkyJS 规范入口 | `skyjs/<name>[/<subpath>]` | ① 内建 `js/builtins/skyjs/<name>`；② npm 包 `node_modules/@skyjs/<name>` 的对应子路径 | 内建表优先，未收录时回退文件系统 |
| 3 用户与第三方 | 其余裸名、相对/绝对路径 | `node_modules/**` 与工程目录 | 文件系统解析 |

层 2 的回退只查 `@skyjs/<name>` 这一个作用域包，不做任意 `skyjs/*` 目录查找。
第三方包**不得**占用 `skyjs/*` 说明符（那会与回退规则冲突），自带能力请用自有
包名。`skyjs/*` 保留的理由因此收窄为一句话：**入口名归 SkyJS，实现位置可以自由**。

判定规则（新增模块时先按此归类）：

- 是 Node 规范定义的模块 → 层 1，只能内建。
- 是 SkyJS 一方提供、希望以稳定入口暴露的能力 → 层 2，内建或 `@skyjs/*` 包皆可。
- 其余一律层 3。

内建优先不是风格取舍，而是为了三件事，它们不再被用来否定 npm 分发：

| 需求 | 内建承重件的作用 | 包提供的代价 |
|---|---|---|
| 移动端与裁剪构建 | 只有内建集保证一定存在于产物中 | 需要把包内容一起打进产物（做法见 §3.2） |
| facade 与原生 ABI 同版本 | 内建实现随运行时发行，天然同版本 | 包版本与运行时版本需要显式约束，靠 peer 依赖与 ABI 校验检查 |
| `features()` 契约稳定 | 模块缺失表现为“能力未编入”，抛 `ERR_UNSUPPORTED_PLATFORM` | 未安装包会被误报为“模块不存在”，需要区分两种失败 |

三者都是**可缓解的工程成本**，不是“不能走 `node_modules`”的理由。

这三项只是判据的**理由**，不是“尽量内建”的倾向：按 §16.4.1，命中判据的 8 个入口
固定内建，其余 8 个领域能力固定走包，不做逐项选型。

因此 `media`、`tag`、`webapp`、`db` 这类模块允许两种发行方式并存。选型不留给
逐个拍板：**引擎只保留承重件，领域能力一律走包**，判据与逐项归属见 §16.4.1。
简表如下（完整版见 §16.4.1）：

| 归层 | 判据 | 例子 |
|---|---|---|
| 引擎内建 | Node 规范模块、与其共用 owner/内核的 facade、Actor 运行时契约、插件安全边界、直接绑引擎原语的零依赖件 | `fs`/`stream`/`http`、`fsx`、`crypt`、`subprocess`、`cluster`、`gateserver`、`pluginHost`、`log`、`testing` |
| `@skyjs` 包 | 领域能力、第三方依赖、原生产物可独立迭代 | `webapp`、`websocket`、`archive`、`config`、`metrics`、`db`、`media`、`tag` |

两种形态共用同一入口与契约：包用 `peerDependencies` 锁运行时版本、原生产物带 ABI
号校验（§3.3、ND-25）；需要 `features()` 精确报告的宿主可把包内容一起打进产物
（§3.2）。

依赖方向：

- 层 3 的 npm 包可以依赖层 1/层 2 入口。
- 内建的层 2 实现不得依赖层 3（否则内建构建不再自洽）。
- 以 `@skyjs/<name>` 发布的包可以依赖层 1 与其它 `skyjs/*` 入口，依赖需在
  `package.json` 中显式声明并受 ABI 约束。

多文件的模块用目录形式（内建 `js/builtins/skyjs/<name>/index.js`，包内为
`index.js` + 子文件），与 Node 面模块同一约定；§16.4.1 表中的 8 个包全部属于此类。

### 3.2 长驻原生模块：cservice 的三种集成形态

本节讲**需要 Actor 隔离的长驻原生能力**（`media` 这类 owner）。它走 skynet 的
cservice ABI，**不是** Node 的 N-API / node-gyp 路线。"JS 直接调用 C 函数"是另一
类需求，形态更轻，见 §3.4。cservice 由 `dlopen(cpath)` 动态加载，再用 `dlsym` 取 `<name>_create` /
`_init` / `_release` / `_signal` 四个入口（`3rd/skynet/.../skynet_module.c`，内核
零修改）。`cpath` 取值来自启动 JSON，支持 `;` 分隔多个搜索路径、`?` 替换为模块名
（`platform/main.c`），因此**搜索路径可以指向 `node_modules`**：

```json
{
  "cpath": "./cservice/?.so;./node_modules/@skyjs/media/native/?.so"
}
```

npm 包因此有三种可用的原生集成形态：

| 形态 | 包内内容 | 加载方式 | 适用 |
|---|---|---|---|
| 预编译 cservice | `native/<name>.so`（每平台一套） | 包声明 cpath 追加项，运行时 `dlopen` | 桌面与服务器；移动端受平台动态加载策略约束 |
| 静态库 | `native/<platform>/lib<name>.a` + 头文件 | **应用构建期**链入 SkyJS 可执行文件，入口符号经 `-rdynamic` / `-export_dynamic` 导出，`builtin-dl.c` 的 wrap 机制按模块名命中 | 移动端 AAR / XCFramework；单可执行文件分发 |
| C/C++ 源码 | `src/**` + 构建脚本 | **应用构建期**由目标工程编译成上述两种产物之一 | 需要与目标平台工具链、ABI、优化选项统一时 |

第三种形态意味着 SkyJS 不必像 Node 那样在 `npm install` 期自动触发 node-gyp：
包可以只**携带** C/C++ 源码与构建脚本，由宿主应用（或 SkyJS 的构建目标）在
构建期把它编成静态库或 `.so`。这与预编译产物并不互斥，同一个包可以两者都带，
由构建配置选择。

形态选择规则：

- 需要被第三方代码动态加载、且目标平台允许 `dlopen` → 预编译 cservice。
- 目标是移动端或单可执行文件 → 静态库（源码可选随包附带）。
- 需要与宿主应用的编译选项/ABI 严格一致 → 源码形态，构建期编译。

约束与成本：

- 三种形态的 ABI 都必须对齐运行时的 cservice ABI：入口符号名、初始化签名、
  以及 `skynetcore` 桥的版本。`builtin-dl.c` 按**模块 basename**（去掉 `.so`）
  匹配内置名，因此包内 `.so` 的文件名即 cservice 模块名。
- **静态链入需要构建期登记模块名**：`builtin-dl.c` 只拦截 `builtin[]` 清单里的
  名字，第三方静态模块必须在应用构建时把模块名写入该清单（现为手写数组，
  见 README"扩展内置清单只需改 `builtin[]`"），否则 wrap 不会命中、真实
  `dlopen` 也找不到已被静态链接的符号。动态加载的 `.so` 不受此限制。
- cservice 模块类型总数有上限（`MAX_MODULE_TYPE = 32`，内核常量）。大量细粒度
  原生包会撞上限，原生能力宜按能力域聚合，而不是一包一模块。
- `cpath` 是**启动期全局配置**，无法在运行时按 `require` 动态追加。因此
  `require('@skyjs/x')` 只负责解析 JS facade；其对应的原生模块必须在启动配置中
  已经可被 `dlopen`，或已静态链入。包需要提供"注册 cpath 追加项"的构建期/
  启动期步骤，这一步由宿主应用完成，而不是 loader 在 require 时完成。
- 移动端确实存在平台差异：动态加载第三方 `.so`/`.dylib` 在 iOS 与部分 Android
  场景受限，所以**移动端推荐静态库形态**。但这限制的是"动态加载"这一种形态，
  **不是"能不能走 `node_modules`"**——包内容照样可以安装进 `node_modules` 并由
  构建期消费。

### 3.3 版本与 ABI 校验

以 npm 包分发的层 2 模块，其 facade 版本与原生 ABI 需要显式约束，不能像内建那样
天然同版本：

- 包在 `package.json` 中声明 `peerDependencies`，锁定兼容的 `skyjs` 运行时版本
  区间。
- 原生产物附带 ABI 版本号，运行时加载后校验；不匹配即抛错，不静默降级。
- `features()` 需要区分两类失败：**模块未安装**（`ERR_MODULE_NOT_FOUND`）与
  **能力未编入/未加载**（`ERR_UNSUPPORTED_PLATFORM`）。

### 3.4 JS 调用 C 代码：C 桥模块

**先厘清三种机制——它们解决的是不同问题，不要混为一谈。**

| 机制 | 加载方式 | JS 侧形态 | 隔离 | 用途 |
|---|---|---|---|---|
| cservice（§3.2） | `dlopen(cpath)` + 四符号约定 | `skynet.newservice` + 消息 | 独立 Actor | 长驻服务、需要配额与调度隔离 |
| **C 桥模块（本节，采纳）** | 编入 `snjs.so`，或按 `package.json#skyjs.native` 解析后 `dlopen` | 进程内同步的 `JS_NewCFunction` 函数对象 | 同地址空间 | **JS 直接调用 C 代码** |
| 通用 FFI（§3.5，不做） | libffi 调任意导出符号 | 签名表 + `ffi_call` | 无 | 免编译调用任意 `.so` |

> 本节曾按"通用 FFI"（libffi + 签名表）设计，那是**方向错误**，已撤回。需要的
> 从来不是"按签名调用任意符号"，而是"**JS 能调用到我们写的 C 函数**"。仓库里
> 已经有一等公民范式：`register_*` 家族。

#### 3.4.1 参照实现：`register_openssl_crypto`

`service-src/js-crypto.c` 就是这件事的标准写法。`js-crypto.c:1186` 的
`register_openssl_crypto()` 归结为一句话：**手写 C 函数，再用 `JS_NewCFunction`
显式挂到一个 JS 对象上**。

```c
/* 1. 一个普通 C 函数：自己取参数、自己转类型、自己返回 JSValue */
static JSValue js_crypt_aes_gcm_encrypt(JSContext *ctx, JSValueConst this_val,
                                        int argc, JSValueConst *argv) {
    /* 手写参数校验与 ArrayBuffer 取址，见 js-crypto.c 实现 */
    ...
}

/* 2. 注册函数：把一批 C 函数挂到一个已存在的 JS 对象上 */
static void register_openssl_crypto(JSContext *ctx, JSValue crypt) {
    JS_SetPropertyStr(ctx, crypt, "aesGcmEncrypt",
        JS_NewCFunction(ctx, js_crypt_aes_gcm_encrypt, "aesGcmEncrypt", 4));
    JS_SetPropertyStr(ctx, crypt, "ed25519Sign",
        JS_NewCFunction(ctx, js_crypt_ed25519_sign, "ed25519Sign", 2));
    /* ... 其余同型 */
}
```

调用链是三层，全部是普通 C 调用，没有一行反射代码：

- `snjs.c:578 register_bridge()`：建 `skynetcore` 对象并挂到全局，随后依次调
  `register_crypto_bridge` / `register_tls_bridge` / `register_io_bridge`
  （`snjs.c:614–618`）注册各能力命名空间。
- `register_crypto_bridge()`（`js-crypto.c:862`）：建 `crypt` 对象，挂基础算法，
  再调下一层。
- `js-crypto.c:1186 register_openssl_crypto()`：把 `USE_OPENSSL` 保护下的
  AES-GCM / Ed25519 / X25519 函数挂上去。

关键性质：**没有签名描述语言，没有 libffi，没有符号名约定**（除了我们自己选定的
注册入口名）。类型转换、边界校验、错误码映射都在 C 函数体里手写，因此可以做
权限判断、配额检查、`AbortSignal` 映射和 Node 风格错误构造。

这也说明了「接入一个已有 C 库」的真实路径：扩展源码 `#include` 目标库的头文件，
在构建期把目标库链接进扩展产物（例如 `-lavcodec`），再手写若干 C 包装函数逐个
`JS_NewCFunction` 挂上去。C 包装层可以直接调用任意 C 函数，因为编译器和链接器
已经知道类型与符号；FFI 唯一多出来的能力是"不写包装、不编译，运行期按签名字符串
调用未知符号"，而这既不是本项目需要的，也正是 §3.5 要拒绝的。

由此还能推出「普通 `.so`」（没有 `skyjs_ext_init`、只是某个第三方库）的处理方式：
运行时**不会**把它直接暴露给 JS。需要它时，写一个 C 桥扩展，在扩展里用
`dlopen` / `dlsym` 加载并按 C 类型声明函数指针，由扩展负责类型转换与生命周期，
对外仍只暴露 `skyjs_ext_init` 挂上的具名函数。这与「运行时提供签名编组」是两件事：
前者把类型知识留在 C 编译单元内，后者把类型知识交给不受控的字符串。

#### 3.4.2 两种落地形态

同一个 C 桥有两种装载方式，按"能力属于谁"选择：

| 形态 | C 源位置 | 编译产物 | 注册入口 | 适用 |
|---|---|---|---|---|
| **内建（引擎承重能力）** | `service-src/js-<name>.c` | 编进 `cservice/snjs.so` | `register_<name>_bridge()`，由 `register_bridge()` 直接调用 | 引擎层 1 模块与承重入口的原语（crypt、tls、fs、seri、netpack、subprocess；`fs` 即重构前的 `io`） |
| **包内（`@skyjs` 包能力）** | 包内 `native/src/*.c` | 独立 `.so` | 导出 `JSValue skyjs_ext_init(JSContext *, JSValueConst ns)` + `int skyjs_ext_abi(void)` | `@skyjs/media`、`@skyjs/tag` 等包自带原生实现；也可构建期静态链接 |

形态选型规则：

- 能力是层 1 模块的依赖、必须随运行时版本化 → 内建。零加载开销，不需要 `extpath`，
  ABI 天然同版本。
- 能力属于领域模块、可独立迭代与按需安装（含 SkyJS 一方的 `@skyjs/media`、
  `@skyjs/tag`）→ 包内。代价是需要固定入口符号与 ABI 校验。

归属判据见 §16.4.1；内建与包内是**同一套 C 桥写法**，区别只在源码位置与加载方式，
不在 API 形状。

内建形态是现状的延续，本节不改变其写法：新增一个引擎 C 桥 = 新增
`service-src/js-<name>.c` + 在 `snjs-internal.h` 声明 + 在 `register_bridge()`
调用 + 在 `Makefile` 的 `snjs.so` 链接行加入 `build/<name>.o`。包内 C 桥不写进
`service-src/`，它随包编译，按 §3.4.3 动态装载或静态链入。

#### 3.4.3 外部 C 桥的装载约定

外部 C 桥与 cservice 的 `cpath` 平行，用启动 JSON 的 `extpath` 作为**动态装载
开关兼兜底搜索根**，`;` 分隔，与 `cpath` 同级配置域（`platform/main.c`，见
infra 01 §3）：

```json
{
  "extpath": "./native-ext"
}
```

装载选路顺序固定，静态优先、动态兜底：

1. **静态链入**（移动端 AAR / XCFramework 等构建期链入的场景）：loader 用
   `skynetcore.native.initStatic(pkgName, ns)` 查 `native-registry.c` 生成的表。
   命中则直接调用登记的 `skyjs_ext_init`，**不需要 `extpath`，也不需要 `dlopen`**；
   此路径下 `extpath` 通常为空。
2. **动态装载**（静态表未命中）：要求 `extpath` 非空且编入了 `NATIVE_EXT=1`，
   任一不满足即 `require` 抛 `ERR_UNSUPPORTED_PLATFORM`。然后 loader 用
   **常规 CJS 解析**拿到包根（`node_modules` 查找规则不变），按
   `package.json#skyjs.native` 的平台键值表得到包内相对路径（§3.4.6），交给
   `skynetcore.native.resolve()` 校验并得到绝对路径后 `dlopen`；包未声明
   `skyjs.native` 时改用 `skynetcore.native.find()` 走下面的兜底规则。

两条路径的先后关系是"先查静态表，未命中再走动态"，不是二选一开关；`extpath`
只约束第 2 步。构建脚本决定把**哪些包静态链入**，这个决定按包生效：被静态登记的
包在第 1 步就命中，永远不走 `dlopen`；其余包在第 2 步按 `extpath` 尝试动态装载。
因此纯静态构建（`extpath` 为空）下，只有静态登记过的包可用，其余包 `require`
抛 `ERR_UNSUPPORTED_PLATFORM`，语义是"该平台未提供此能力"。

`extpath` 的每一项是一个**目录**（不是 `cpath` 那种 `?` 路径模式），`;` 分隔，
`{libext}` 指 `so` / `dylib` / `dll`。它只在**包未声明 `skyjs.native` 时**作为
兜底查找根：loader 按顺序尝试 `<根>/<包短名>/<platform>-<arch>/<包短名>.{libext}`
与 `<根>/<包短名>.{libext}`（包短名 = 去掉 scope 的名字，
`@skyjs/example-native` → `example-native`）。常规情况用包内
`skyjs.native` 声明；两种方式都属于动态装载，都要求 `extpath` 非空（即第 2 步的
前置条件）。

约定与约束：

- 一个扩展 `.so` 导出**唯一固定入口**
  `JSValue skyjs_ext_init(JSContext *ctx, JSValueConst ns)`：`ns` 是运行时预先
  建好的空对象，扩展把全部函数挂到它上面，并**返回模块导出值**（通常就是 `ns`
  自身，省略 `main` 的纯原生包尤其如此）。返回值是 `JS_EXCEPTION` 或未设置异常
  的错误值即视为装载失败，loader 转为 Node 风格错误抛出。固定单入口让 `dlsym`
  不必猜符号名，也让"一包一模块"的映射保持简单。
- loader 在求值 `require('@scope/<name>')`（或 `require('skyjs/<name>')` 回退到包）
  时调用一次 `skyjs_ext_init`，得到的对象即模块导出值；之后反复 `require` 走
  模块缓存，不会重复初始化。
- 入口必须带 ABI 版本，避免运行时与扩展错配后直接崩溃：扩展额外导出
  `int skyjs_ext_abi(void)`，loader 在调用 `skyjs_ext_init` 之前先 `dlsym` 并校验。
  **C 符号是权威值**；`package.json#skyjs.abi` 是可选元数据，只在同时存在时做
  二次比对。缺失 `skyjs_ext_abi` 或版本不匹配一律抛错，不静默降级（与 §3.3 的
  ABI 校验同一条规则）。静态路径同样要过这一关：`native-registry.c` 的表里登记
  了 `abi_fn`，由 `initStatic()` 调用后与运行时 ABI 比对，不走 `dlsym`。
- 扩展 `.so` 用 `RTLD_NOW | RTLD_LOCAL` 打开：`RTLD_NOW` 让缺失符号在加载期
  立即报错而不是运行期随机崩溃；`RTLD_LOCAL` 避免扩展之间互相覆盖符号。
  `RTLD_LOCAL` 只限制"扩展往全局作用域**新增**符号"，不影响解析；扩展未定义的
  QuickJS 符号来自**主程序** `skyjs` 的导出表（`QJS_OBJ` 链入主程序，Linux 经
  `-rdynamic`、macOS 默认导出、MinGW 经 `--export-all-symbols` 与 import
  library）。本机 macOS 实测：`skyjs` 定义了 253 个 `JS_*` 全局符号，而
  `cservice/snjs.so` 的 `JS_*` 全是未定义引用（65 个），印证 QuickJS 由主程序
  提供。`snjs.so` 自身由 `skynet_module.c` 以 `RTLD_GLOBAL` 打开，其导出符号
  同样可见。
- 静态构建（移动端 AAR / XCFramework、`STATIC=1`）下把扩展源码/静态库链入
  主程序，由选路第 1 步的静态表命中，`extpath` 留空。与 §3.2 的 cservice
  静态链入不同，这里不需要登记 `builtin[]`：`builtin[]` 只服务于 skynet 的
  cservice 四符号解析。
- **静态链入多个扩展时符号名必须唯一**：动态装载时每个 `.so` 各自一个
  `skyjs_ext_init`，走 handle 查找互不干扰；但静态链入时所有扩展落在同一符号
  空间，同名符号会链接冲突（或 `initStatic` 只命中第一个）。解决办法是构建期按
  包名改写符号并生成登记表：编译每个静态扩展时加
  `-Dskyjs_ext_init=skyjs_ext_init_<pkg> -Dskyjs_ext_abi=skyjs_ext_abi_<pkg>`
  （`<pkg>` 为包名 sanitize 后的形式），同时生成 `native-registry.c` 里的
  `{name, abi_fn, init_fn}` 数组，`initStatic` 按包名查表、直接调用函数指针，
  全程不做 `dlsym`。这条规则只影响静态构建；包自身的源码仍只写
  `skyjs_ext_init` / `skyjs_ext_abi` 两个名字。
- 一个扩展内部可以再拆多个 `.c`，但对 ABI 只暴露 `skyjs_ext_abi` 与
  `skyjs_ext_init` 两个符号。
- 扩展作者需要的头文件与符号声明由 SkyJS 随包发布，避免各包各写一份：新增
  `include/skyjs-ext.h`（定义 `SKYJS_EXT_ABI_VERSION`、两个入口的声明、导出宏
  `SKYJS_EXT_EXPORT`——Windows 下展开为 `__declspec(dllexport)`，其它平台展开为
  `__attribute__((visibility("default")))`/空），以及随附的 `quickjs.h` /
  `quickjs-libc.h`（构建期从 `3rd/quickjs` 复制，始终与运行时内置 quickjs 同版本）。扩展源码只写
  `#include "skyjs-ext.h"`，`JS_*` 符号在桌面链接期解析到主程序导出表或 import
  library，静态构建则由构建脚本一并链入。
- **MinGW 需要单独分支**：skynet 自带的 `3rd/skynet/3rd/compat-mingw/dlfcn.c`
  把 `dlopen` 实现为 `LoadLibraryA`（**忽略 flags**，`RTLD_LOCAL` 不生效），且
  `dlopen(NULL)` 拿不到主程序句柄。因此 Windows 下：扩展装载用
  `LoadLibraryA(path)` + `GetProcAddress`；解析主程序导出符号改用
  `GetModuleHandleA(NULL)`；静态链入仍走 `--export-all-symbols` 生成的
  import library。扩展源码本身不用改，但入口必须带 `SKYJS_EXT_EXPORT`，否则
  `GetProcAddress` 取不到。这条差异只影响 `js-native.c` 与导出宏的实现。

#### 3.4.4 内存与资源的责任边界

C 桥与调用方处于同一地址空间、同一个 Actor 内，因此**不能靠"独立服务"来隔离**，
这决定了它的约束：

- 计入 `jsMemLimit` 的只有 QuickJS 分配器（`js_malloc` / `JS_New*` 系列，经
  `JS_NewRuntime2` 的自定义分配器进入 per-service 记账，`snjs.c:73 js_allocf`）。
  `skynet_malloc` 在当前构建（`-DNOUSE_JEMALLOC`，见 `Makefile`）就是普通
  `malloc`，**不参与 per-service 记账**；`3rd/skynet/skynet-src/skynet_malloc.h`
  里的 `skynet_malloc` 宏即 `malloc`。
- 因此规则是：**能在 QuickJS 堆里放的数据就放 QuickJS 堆**——用
  `JS_NewArrayBufferCopy()`（拷贝进 JS 堆，计入限额）或 `JS_NewString` 系列；
  需要零拷贝或接管已有缓冲区时用 `JS_NewArrayBuffer(ctx, buf, len, max_len,
  realloc_func, opaque, is_shared)`，并**必须**提供 `realloc_func`：按 QuickJS
  约定 `size == 0` 表示释放该块，非 0 表示扩容；`service-src/js-seri.c:680`
  就是这个用法。传 `realloc_func = NULL` 时 QuickJS 完全不管这块内存，一旦忘记
  自行释放就必然泄漏。
- 这类外部内存**不在 `jsMemLimit` 内**（限额只统计走 `js_malloc` 的分配），
  所以由扩展自己给原生缓冲区设上限并保证释放，不能指望运行时兜底。
- 原生句柄（`stdio` FILE*、libav 上下文、TagLib 文件对象）的生命周期必须挂在
  某个 JS 对象的 finalizer 上，或由 owner service 持有；C 桥形态下没有 owner
  service 兜底，实现方自己负责"service 释放时把句柄收干净"。

> 待验证项（NC5）：确认扩展 `.so` 在 `RTLD_LOCAL` 下能稳定解析到主程序导出的
> QuickJS 符号（Linux 靠 `-rdynamic`，macOS 实测主程序已导出 253 个 `JS_*`
> 符号，MinGW 靠 `--export-all-symbols` 与 import library），并把结论写回本节。

与 cservice 的关系：两者可以共存，选型规则是"**需要 Actor 隔离与配额 → cservice；
只需要一个同步函数调用 → C 桥模块**"。`media`/`tag` 这类重任务仍走 `.media`
owner（§3.2）。C 桥模块比 cservice 少一层服务边界，也少一层隔离，因此：

- 插件 VM 一律看不到任何 C 桥模块（白名单只放 `skyjs/pluginHost` 的 bridge）。
- C 桥模块的 API 必须是显式白名单函数，不做"把整库符号暴露给 JS"的反射。
- 需要配置开关与 `features()` 能力键，未编入时 `require` 抛
  `ERR_UNSUPPORTED_PLATFORM`。

#### 3.4.5 需要的 L1 原语

命名落在 `skynetcore.native`，挂在已有的 `skynetcore` 全局对象下。它没有公开
模块入口（不存在 `require('skyjs/native')` 之类），只有 loader 与同类内部代码会
调用；但要讲清楚：`skynetcore` 本身对**受信服务脚本**可见（`snjs.c:613` 把它挂到
全局），所以"仅 loader 可见"是契约约定，不是沙箱边界。真正的安全边界有两道——
插件 VM 完全不注入 `skynetcore`（§11），以及下面 `load()` 的 ABI 门禁：它只接受
导出 `skyjs_ext_abi` / `skyjs_ext_init` 的扩展库，不提供按符号名调用任意函数的
能力（§3.5、ND-30）。

```text
skynetcore.native.enabled() -> bool
    // 编入了 NATIVE_EXT=1 即为 true，与 extpath 无关。静态与动态两条路径都算
    // "原生能力可用"，因此移动端静态构建（extpath 为空）也返回 true；它只表示
    // skynetcore.native 这套原语存在，不代表一定能 dlopen
skynetcore.native.dynamicEnabled() -> bool
    // enabled() 且 extpath 非空：动态装载的总开关（§3.4.3 第 2 步的前置条件）
skynetcore.native.staticEnabled() -> bool
    // enabled() 且 native-registry.c 生成了非空静态表：静态链入路径是否可用。
    // 普通动态构建没有静态表，返回 false；纯静态构建（移动端）返回 true
skynetcore.native.resolve(pkgRoot, relPath) -> string | null
    // 包内相对路径 → 绝对路径；做存在性、文件类型与越界（../ 逃出包根）校验。
    // 平台键由 loader 选定，C 侧不解读 package.json
skynetcore.native.find(pkgName, platform, arch) -> string | null
    // 包未声明 skyjs.native 时的兜底查找：按 §3.4.3 的顺序在各 extpath 根下
    // 拼平台目录与默认文件名，返回第一个命中的绝对路径
skynetcore.native.load(path) -> handle | null
    // dlopen(RTLD_NOW|RTLD_LOCAL)；已加载的同一路径复用句柄并加引用计数
skynetcore.native.abi(handle) -> int
    // dlsym("skyjs_ext_abi")；缺失即失败（版本比对在 JS 侧，便于报错文案统一）
skynetcore.native.init(handle, ns) -> JSValue
    // dlsym("skyjs_ext_init") 并调用一次，返回模块导出值
skynetcore.native.initStatic(pkgName, ns) -> JSValue
    // 静态构建专用：查 native-registry.c 生成的表，直接调用登记的函数指针，
    // 全程不经过 dlsym；未登记的包名返回 null。ABI 校验由本原语自己完成
    // （表里同时登记了 abi_fn，直接调用后与运行时 ABI 比对），因此静态路径
    // 不需要也没有 handle，不经过 abi()
skynetcore.native.unload(handle)
    // 服务释放时清理；实现内部保证引用计数，已无引用才 dlclose
skynetcore.native.errmsg() -> string
```

`dlopen` 句柄是**进程级共享**的，而 `skyjs_ext_init` 是**每 service 一次**的：
同一个扩展被 N 个 service `require` 时，句柄复用、各 service 各自拿到自己的
导出对象，不能把 JSValue 或 `JSContext *` 存进扩展的全局静态变量。句柄按
service 维度记引用，最后一个引用释放时才 `dlclose`，避免扩展被卸载后 worker
线程仍持有其函数指针。静态路径没有句柄可记，`unload` 在静态构建下是空操作，
扩展生命周期与主程序一致。

路径相关的原语都放在 C 侧，是为了让文件系统访问不经过 JS、越界校验只有一份
实现，也让静态/动态两条路径共用同一套平台命名约定。loader 只负责读
`package.json`、决定用哪个平台键，以及把 `module.native` 注入模块作用域；它
不自己拼路径。

两种"整套原语缺席"的情况由 loader 统一降级处理，不抛内部错误：

- **未编入 `NATIVE_EXT=1`**：`skynetcore.native` 根本不存在。loader 在遇到声明了
  `skyjs.native` 的包时直接抛 `ERR_UNSUPPORTED_PLATFORM`（能力未编入），不再往下走。
- **编入了但无静态表**：普通动态构建不生成 `native-registry.c`，`initStatic()`
  一律返回 `null`（空表），选路自然落到第 2 步；这不是错误。

实现落点 `service-src/js-native.c`，构建开关 `NATIVE_EXT=1`。
`enabled()` / `dynamicEnabled()` 对外投影为 `skynet.features().nativeExt` 的
`available` / `dynamic`，`staticEnabled()` 投影为 `static`（infra 01 §5）。

#### 3.4.6 扩展包的目录布局

外部 C 桥包与普通 npm 包同构，只是多出原生目录：

```text
node_modules/@skyjs/example-native/
├── package.json          # main 指向 index.js；声明 peerDependencies 与 skyjs.native
├── index.js              # CJS facade：require 到的就是这个文件（纯原生包可省略）
├── native/
│   ├── darwin-arm64/libexample.dylib
│   ├── linux-x64/libexample.so          # 预编译产物，按 platform-arch 分目录
│   └── src/example.c     # 或随包携带 C 源码，构建期编译（§3.2 形态三）
├── types/index.d.ts
└── test/
```

`index.js` 里通常只做两件事：把原生对象的函数重命名/包装成公开 API，以及
补 Node 风格错误语义。原生命名空间由 loader 通过 `module.native` 注入给该包的
入口模块（仅对声明了原生绑定的包可见，不暴露给其它模块）：

```js
// index.js：module.native 是 loader 调 skyjs_ext_init 得到的命名空间
const native = module.native;
module.exports = { crc32: (buf) => native.crc32(Buffer.from(buf)) };
```

若包是**纯原生**（不需要 JS 包装），可以不写 `index.js`：省略 `main`、只声明
`skyjs.native`，loader 把 `skyjs_ext_init` 的**返回值**直接作为 `module.exports`。
这条路径与 `register_openssl_crypto` 的形状完全一致——都是"拿到一个对象，把 C
函数挂上去"。JS facade 形态则通过 `module.native` 取到同一个返回值。包用
`package.json` 声明原生绑定，`native` 支持两种写法：

```json
{
  "name": "@skyjs/example-native",
  "main": "index.js",
  "peerDependencies": { "skyjs": "^0.2.0" },
  "skyjs": {
    "native": {
      "darwin-arm64": "native/darwin-arm64/libexample.dylib",
      "linux-x64": "native/linux-x64/libexample.so",
      "android-arm64": "native/android-arm64/libexample.so"
    },
    "abi": 1
  }
}
```

单平台包可以简写成字符串，等价于只对当前平台生效：

```json
{
  "skyjs": {
    "native": "native/libexample.so",
    "abi": 1
  }
}
```

键值表的键取 `"<platform>-<arch>"`（`platform`/`arch` 值与 Node 的
`process.platform`/`process.arch` 同源）。键缺失即视为该平台无产物，`require`
抛 `ERR_UNSUPPORTED_PLATFORM`。路径必须是包内相对路径且不得逃出包根。动态装载
时这些字段即最终路径；静态构建（移动端）时构建脚本用同一张表挑出要链入的
`src/**` 或静态库（§3.2 形态三、infra 13 §13.3）。

`skyjs.abi` 是可选元数据，权威值来自扩展导出的 `skyjs_ext_abi()`；两者同时
存在时做二次比对，不一致即抛错（§3.3）。

一个最小扩展的 C 侧全部内容就是这样（对应 §3.4.1 的 `register_*` 形状，只是
入口换成 ABI 约定的两个符号）：

```c
#include "skyjs-ext.h"

static JSValue js_example_crc32(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv) {
    size_t len;
    uint8_t *p = JS_GetArrayBuffer(ctx, &len, argv[0]);
    if (!p) return JS_EXCEPTION;            /* 参数校验留在 C 侧 */
    return JS_NewUint32(ctx, crc32(p, len)); /* 具体实现略 */
}

SKYJS_EXT_EXPORT int skyjs_ext_abi(void) { return SKYJS_EXT_ABI_VERSION; }

SKYJS_EXT_EXPORT JSValue skyjs_ext_init(JSContext *ctx, JSValueConst ns) {
    JS_SetPropertyStr(ctx, ns, "crc32",
        JS_NewCFunction(ctx, js_example_crc32, "crc32", 1));
    return JS_DupValue(ctx, ns);            /* 返回值即 module.exports */
}
```

### 3.5 通用 FFI：不做

上一版曾把"任意动态库调用"设计成 `skyjs/ffi`（libffi + 签名表）。**该方案撤回**，
理由：

- 与 §3.4 的 C 桥相比，FFI 只是省掉了"写一层 C 包装"的工作量，却引入了
  一整套类型系统（长度截断、结构体布局、指针生命周期）需要持续维护。
- 它与隔离模型直接冲突：签名驱动的调用绕过内存记账，ABI 不匹配即段错误终止
  宿主；这正是本文件 §1"资源安全"原则要避免的。
- 实际需求（把某个 C 库接进 JS）用 C 桥的 `register_*` 模式已经覆盖，且
  可以在包装层做权限、配额与错误映射。扩展内部若需加载一个没有 SkyJS 入口的
  第三方 `.so`，由扩展自己在 C 侧 `dlopen` / `dlsym` 并按函数指针类型调用，
  见 §3.4.1；运行时**不**向 JS 暴露"按任意符号名取函数地址"的原语，连调试口子
  也不留，避免它演变成非受控的通用调用面。§3.4.5 的 `skynetcore.native.*` 不
  构成这种口子：`abi()` / `init()` 只按**写死的** `skyjs_ext_abi` / `skyjs_ext_init`
  两个名字取符号，没有任何原语接受调用方给出的符号名，也不会把符号地址还给 JS
  （拿到的 `handle` 是不透明值，只能回传给同族原语；loader 的 `load → abi →
  init` 顺序要求扩展必须导出这两个符号，否则整条装载失败）。因此"能不能加载一个
  库"和"能不能任意调用其符号"是分开的：前者开放，后者不开放，且只对声明了
  `skyjs.native` 的扩展库生效。

## 4. 核心决策

### 4.1 `process.exit()`

**决策：退出宿主进程。**

映射语义：

```js
process.exit()        // 等价于 process.exit(0)
process.exit(code)    // 以 code 作为宿主进程退出码
```

规则：

- `process.exit()` 与 `process.exit(0)` 均视为正常退出。
- `code` 直接作为宿主进程退出码，由外部 supervisor 读取。
- 语义对齐 Node：未完成的异步任务不保证执行完成。
- 调用后终止宿主内全部 Actor service；OS 级资源由进程退出回收。
- SkyJS 可在退出前尽力输出一条宿主退出日志，但不得为了等待清理而阻塞退出。

实现落点（现状不满足，必须补）：

- 现有 `js/skynet.js` 的 `skynet.exit()` 走 `skynetcore.command("EXIT")`，只 retire
  当前 service，不影响宿主；`process.exit` 不能复用它。
- 新增 C 原语 `skynetcore.runtime.exit(code)`：记录退出码并调用 skynet 命令 `ABORT`
  （`skynet_handle_retireall()`）。当 `skynet_context_total()==0` 时 `skynet_start()`
  的 worker/timer/monitor 线程按 `CHECK_ABORT` 退出，控制权回到 `platform/main.c`。
- 退出码保存在 C 侧一个进程级槽位，由 `process.exit(code)` 与 `process.exitCode`
  共用（§4.5）。`platform/main.c` 在 `skynet_start(&config)` 返回后读取该槽位并
  `return`，取代现在固定 `return 0`；槽位从未被写过时返回 0。
- `process.exit` 的 JS 侧实现是"写退出码 → 触发全局 ABORT → 抛内部哨兵异常展开当前
  调用栈"，不等待 `fs`/`subprocess` owner 清理；owner 的兜底回收依赖进程退出，
  而不是 service 级优雅关停。
- 哨兵只在运行时边界（`worker_cb`、service init、dispatch、定时器回调）被吞掉；
  `dispatch`/`init` 的兜底错误日志要识别该哨兵并静默返回，避免把正常退出记成
  `dispatch error`。ABORT 之后 `worker_cb` 的 pending-job drain 立即停止，
  不再执行任何后续回调。
- 已知差异：QuickJS 没有"不可捕获异常"，因此用户代码若在 `process.exit()` 外层写
  `try { ... } catch {}`，可以拦截这个哨兵，`process.exit()` 会在 `catch` 之后返回。
  运行时仍保证退出码已写入且不再执行任何回调，宿主照常退出；该差异写入兼容差异表
  （§12 验收项按"退出码正确"而非"永不返回"判定）。
- 插件 VM 不暴露该原语（见 §11），插件内的 `process.exit` 只能是受限 facade。

### 4.2 `process.env`

**决策：宿主 environ 的 Actor 局部快照。**

- `process.env` 初始值来自**宿主进程 environ**（非 skynet 配置域）在服务启动时刻的
  拷贝，`PATH`/`HOME` 等保持可用；skynet 配置键不进 `process.env`，仍走
  `skynet.getenv`。
- 对 `process.env` 的写入或删除只影响当前 Actor 的局部视图：不修改宿主环境，
  不影响其他 Actor；快照之后宿主侧 `setenv` 的变化不反映进来。
- 后续 `child_process` 等子进程能力默认使用当前 Actor 的局部视图。

### 4.3 `process.cwd()` 与 `process.chdir()`

**决策：只支持 Actor 局部 cwd。**

- `process.cwd()` 返回当前 service 的逻辑工作目录。
- `process.chdir()` 初始版本抛出 `ERR_UNSUPPORTED_PLATFORM`。
- 原因：POSIX cwd 是进程级全局状态，与 Actor 隔离模型冲突。

### 4.4 `process.argv`

**决策：使用 Actor 局部 argv。**

```js
process.argv = [execPath, scriptPath, ...bootstrapArgs]
```

规则：

- `execPath` 表示 SkyJS 可执行文件路径。
- `scriptPath` 表示当前服务入口脚本路径。
- 其余参数来自服务启动配置。
- 不使用宿主进程的原始 `argv`。

### 4.5 `process` 对象暴露面

除以下明确列出的成员外，`process` 不实现其他属性；读取未实现成员得到 `undefined`，
不抛异常。这与 Node 的宽松对象语义一致，也能让探测式代码（`if (process.foo)`）正常
降级。

| 成员 | 语义 | 落点 |
|---|---|---|
| `process.version` | 对标 Node 版本字符串（`"v20.x.x"`，见 ND-13） | JS 常量 |
| `process.versions` | 至少含 `{ node, skyjs, quickjs }` | `skynet.features()` |
| `process.platform` / `process.arch` | 宿主平台与架构（`darwin`/`linux`、`arm64`/`x64`）；`require('os')` 复用同一来源 | `skynetcore.runtime.info()` |
| `process.pid` | 宿主进程 pid（同一宿主内所有 Actor 相同） | `skynetcore.runtime.info()` |
| `process.ppid` | 宿主父进程 pid | `skynetcore.runtime.info()` |
| `process.argv` / `process.argv0` / `process.execPath` | 按 §4.4 的 Actor 局部语义 | `skynetcore.runtime.argv()` |
| `process.env` | 按 §4.2 的 Actor 局部快照 | `skynetcore.runtime.environ()` |
| `process.cwd()` / `process.chdir()` | 按 §4.3 | 运行时信息 + `ERR_UNSUPPORTED_PLATFORM` |
| `process.exit()` | 按 §4.1 | `skynetcore.runtime.exit()` |
| `process.nextTick()` | 按 §5.3 | `internal/event-loop` |
| `process.exitCode` | 可写；写入 §4.1 的进程级退出码槽位，宿主自然关停时生效（默认 0）。`process.exit()` 立即终止，忽略此值 | `skynetcore.runtime.exitCode` |
| `process.hrtime()` / `process.hrtime.bigint()` | 单调时钟：`[秒, 纳秒]` 数组 / 纳秒 bigint，供基准与超时使用 | `skynetcore.runtime.hrtime()` |
| `process.memoryUsage()` | 至少 `{ rss, heapTotal, heapUsed, external }`，单位字节 | `skynetcore.runtime.mem()` + QuickJS 内存统计（原扁平名 `skynetcore.mem()`，见 §16.5） |
| `process.uptime()` | 宿主进程已运行秒数 | `skynetcore.runtime.info()` |
| `process.stdout` / `process.stderr` | 映射到 skynet 日志通道；NC0 提供 `write()`/`isTTY=false`/事件订阅的最小可写实现，NC2 起换成 `internal/stream-core` 的完整 `Writable` | `internal/event-loop`（NC0）→ `internal/stream-core`（NC2） |

不实现：`process.stdin`（Actor 模型下无统一控制台输入语义，初始版本为 `null` 而非
空流）、`process.kill()`、`process.umask()`、`process.getuid()`/`getgid()` 系列、
`process.setuid()` 系列、`process.title`、`process.abort()`、`process.on('exit'|'SIG*')`
信号监听。未实现项若要引入，先补本节与决策记录，不直接加进实现。

`process.exitCode` 与 `process.exit()` 的关系：两者写同一退出码槽位，但只有
`process.exit()` 立即触发 `ABORT`。若代码只设置 `exitCode` 而让宿主自然关停，
`platform/main.c` 仍会读到该值；两者都通过 §4.1 的同一条回传通道生效。

## 5. 定时器语义

### 5.1 支持范围

- `setTimeout`
- `clearTimeout`
- `setInterval`
- `clearInterval`
- `setImmediate`
- `clearImmediate`
- `queueMicrotask`
- `process.nextTick`
- `Timeout.ref()`
- `Timeout.unref()`

### 5.2 关键差异

- 外部接口使用毫秒，内部映射到 SkyJS 定时器精度（`skynet.timeout` 的 10 ms 单位）。
- 首版定时器精度即 10 ms，向上取整到下一个 tick；小于 10 ms 的延时按 10 ms 处理。
  该差异写入兼容差异表，不承诺亚 10 ms 精度。
- `setImmediate` 在当前回调与已排队的 microtask 之后执行；与到期 `setTimeout(0)`
  的相对顺序固定为 immediate 先（tick 顺序 nextTick → microtask → immediate →
  到期定时器，§16.7）。Node 本就不保证两者顺序，此固定选择写入差异表（§12.1）。
- `process.nextTick` 不直接映射为 `queueMicrotask`，按 §5.3 的独立队列实现。
- 不追求 libuv 全部阶段的严格复刻，只保证 nextTick 与 Promise microtask 的相对优先级。

### 5.3 `process.nextTick` 严格顺序指什么

Node 在同一个事件循环检查点内有两个微任务队列，且有固定优先级：

1. 先清空 `process.nextTick` 队列。
2. 再清空 Promise microtask 队列。

```js
Promise.resolve().then(() => console.log("promise"));
process.nextTick(() => console.log("nextTick"));

// Node: nextTick -> promise
```

如果把 `process.nextTick` 直接映射为 `queueMicrotask`，输出会变成
`promise -> nextTick`。依赖 Node 这种顺序的代码会发生可观察的行为差异，这就是
“严格顺序”的含义。

实现规则：

- 运行时维护独立的 nextTick 队列。
- 在每个宏任务/回调边界先排空 nextTick 队列，再进入 Promise microtask 队列。
- 在 nextTick 回调内再次调用的 nextTick 继续排在同一轮，保持在 Promise microtask 之前。
- 在 Promise/`queueMicrotask` 回调内新增的 nextTick 不抢占当前 microtask 队列；它会在
  当前 microtask 队列清空后、执行下一个宏任务之前运行。
- `queueMicrotask` 与 Promise microtask 共用同一队列，保持注册顺序。

不承诺完整复刻 libuv 各阶段（poll、check、timer 等）的精确交错顺序；只保证
nextTick 与 Promise microtask 之间的优先级对齐 Node 语义。

实现落点：QuickJS 的 `JS_ExecutePendingJob` 只能表达统一的 job 队列，无法区分
nextTick 与 Promise microtask。需要在 `service-src/snjs.c` 的 worker 回调与 pending
job drain 边界增加 nextTick drain 钩子，先清空 JS 侧 nextTick 队列，再执行 QuickJS
pending jobs。

## 6. 错误映射

Node 兼容层的错误对象必须优先保持 Node 面向调用方的字段：

```js
try {
  await fs.promises.readFile(path);
} catch (err) {
  err.code;    // "ENOENT"
  err.errno;
  err.syscall;
  err.path;
}
```

SkyJS 内部错误分类放在独立字段中：

```js
err.detail.skyjsCode = "ERR_NOT_FOUND";
```

规则：

- 不将 SkyJS 错误码直接替换 Node 的 `err.code`。
- 保留 Node 常见错误码，如 `ENOENT`、`EACCES`、`EEXIST`。
- 保留 `errno`、`syscall`、`path`、`dest` 等 Node 常用字段。
- 保留 `AbortError` 语义。
- SkyJS 错误分类必须可归并到 `ERR_*` 体系。

## 7. Buffer

### 7.1 基础语义

`Buffer` 是 `Uint8Array` 子类，覆盖面与 `fs` 同口径：**Node 20 `buffer` 模块公开
API 全覆盖**——全部静态与实例方法（含 `read*`/`write*` 系列）、`base64`/`base64url`/
`hex` 等编码、`Blob`/`File`、`constants`、`kMaxLength`、`isAscii`/`isUtf8` 均在
范围内。明确例外记入差异表（§12.1）：

- `SlowBuffer` 已废弃，不实现。
- `buffer.transcode()` 依赖 ICU，QuickJS 无 ICU，调用抛 `ERR_UNSUPPORTED_PLATFORM`。
- `Buffer.poolSize` 保留字段但不池化（§7.2 零初始化约束下池化无意义）。

### 7.2 安全约束

- 初始实现中 `Buffer.allocUnsafe` 也应返回零初始化内存。
- 真正的非零初始化分配需独立安全评审后再引入。
- 所有 `Buffer` 共享底层 `ArrayBuffer` 的行为必须显式测试。

### 7.3 `Buffer.allocUnsafe` 零初始化指什么

Node 的 `Buffer.allocUnsafe(size)` 不保证返回内容，内存可能包含此前释放的数据。
这是为了省去清零开销，但也意味着错误泄露 buffer 时可能暴露陈旧内存。

“零初始化”就是实现上仍然把整块内存填 `0`：

```js
const a = Buffer.alloc(16);       // Node 保证全 0
const b = Buffer.allocUnsafe(16); // Node 不保证内容；SkyJS 初始方案也返回全 0
```

初始选择零初始化的原因：

- 避免 QuickJS/Actor 隔离下的内存残留泄露。
- 与 `Buffer.alloc` 行为一致，降低调试不确定性。
- 牺牲一次清零开销；后续若引入 buffer pool，再单独评审非零初始化策略。

依赖 `allocUnsafe` 脏内容的应用不属于兼容承诺范围。

## 8. 文件系统（`fs`）

**决策：首版完整覆盖 Node 20 `fs` 公开 API。**

“完整”的边界是 API 覆盖面与调用形式，不是绕过权限模型。API 清单以 Node 20.x
最新 LTS 文档为基线：

- 入口：`fs`、`node:fs`、`fs/promises`、`node:fs/promises`。
- 调用形式：callback 风格、同步 API、Promise API 全部提供。
- 文件：`open`/`close`/`read`/`write`/`appendFile`/`truncate`/`readv`/`writev`、
  `readFile`/`writeFile`、`FileHandle`、`fsync`/`fdatasync`。
- 元数据：`stat`/`lstat`/`fstat`/`statfs`、`access`、`chmod`/`chown`/`lchmod`/
  `lchown`/`utimes`/`lutimes`、`Stats`、`Dirent`、`constants`、flags。
- 目录与路径：`mkdir`/`rmdir`/`rm`/`mkdtemp`/`readdir`/`opendir`/`Dir`、
  `rename`/`copyFile`/`cp`/`realpath`、`link`/`symlink`/`readlink`。
- 流：`createReadStream`/`createWriteStream`，支持 `start`/`end`/`highWaterMark`/
  `encoding`/`mode`/`flags` 等 Node 常用选项。
- 监听：`watch`/`watchFile`/`unwatchFile`、`FSWatcher`/`StatWatcher`。
- 其他：`exists`/`existsSync`、`openAsBlob`、`constants`、平台相关 flags。

`fs.glob`/`fs.globSync` 是 Node 22 新增 API，不在 Node 20 基线内；本阶段不作为
完整 `fs` 的交付项。

实现映射：

- 同步 API 落到 `skynetcore.fs` 原语（原 `skynetcore.io`，见 §16.5 重命名）。
- 异步 callback/Promise API 落到 `.fs` owner service，经 `fs` 客户端库转发。
- `createReadStream`/`createWriteStream` 复用 `stream` 基础能力与 `.fs`。
- `watch`/`watchFile` 由 `.fs` 持有原生 watcher：C 侧（`js-fs.c`）起 watcher 线程跑
  平台机制（macOS kqueue `EVFILT_VNODE`；Linux 预留 inotify，按平台基线未实测不
  承诺），事件经 skynet 消息队列注入 `.fs` owner——与 socket_server 线程注入
  SOCKET 消息同一机制，不改内核事件循环。

完整 `fs` 还依赖 Node 全局 `Blob`：`fs.openAsBlob()` 的返回类型是 `Blob`，因此
`Blob`/`File` 与 `require('buffer')` 必须在 NC2 之前落地，不能把 `openAsBlob`
留成悬空实现。

安全与差异：

- 所有路径仍经过 SkyJS 权限边界与配额校验；拒绝访问时映射为 Node 风格
  `EACCES`/`EPERM`，而不是暴露底层 SkyJS 错误码。
- 同一路径的多个并发写、软链接与硬链接语义按 Node 20 对照测试。
- `watch` 事件粒度与 `recursive` 能力受平台限制；macOS 为首要平台，Linux 未实测。
  平台不支持时必须抛 `ERR_UNSUPPORTED_PLATFORM`，不能静默降级为轮询而不记录。
- 平台本身缺失的 syscall（例如某些 Windows 特有差异）必须按 Node 的平台行为抛
  `ENOSYS`/`ERR_UNSUPPORTED_PLATFORM`，并在兼容差异表中记录。
- 不承诺 native addon 或外部直接创建的 fd 能透明接入。

### 8.1 交付要求

- NC2 必须一次性交付完整 `fs`，不允许只交付 `fs/promises` 后把 callback/sync 留到后续。
- `fs` 与 `fs/promises` 的测试必须覆盖 Node 20 对照用例、错误码、取消、权限拒绝与
  资源回收。

### 8.2 对 SkyJS 基建的增量要求

现有 [infra/05-fs-archive.md](infra/05-fs-archive.md) 已定义 `fs` 客户端库与
`.fs` owner service，但不足以覆盖 Node `fs` 公开 API。首版前需至少补充：

- 文件句柄级原语：`fchmod`/`fchown`/`futimes`/`fdatasync`、`readv`/`writev` 的
  等价能力，或由 owner service 内实现组合。
- 元数据：`chown`/`lchown`/`utimes`/`lutimes`/`statfs`，以及 Node `Stats` 的完整字段。
- 监听：`watch`/`watchFile` 的原生 watcher 生命周期、事件合并与取消清理（watcher 线程 + 消息注入，§8）。
- 流：`createReadStream`/`createWriteStream` 的 `start`/`end`/`highWaterMark`/错误传播
  与 `.fs` fd 生命周期衔接。
- 错误映射：底层 `ERR_NOT_FOUND`/`ERR_PERMISSION`/`ERR_IO` 到 Node `ENOENT`/
  `EACCES`/`EIO` 等 `code`、`errno`、`syscall`、`path` 字段的完整映射表。

上述缺口需要同步补入 `docs/infra/05-fs-archive.md` 或独立增补章节，避免 Node 兼容层
直接绕过既有 owner service 设计。

## 9. 模块系统

### 9.1 CommonJS

初始实现只支持 CommonJS，ESM 后置：

- `module.exports`
- `exports`
- `require`
- `module.id`
- `module.filename`
- `module.loaded`
- `module.require`
- `__filename`
- `__dirname`

模块缓存按 `realpath` 规范化后的绝对路径索引，避免软链接导致同一模块产生多个
实例。支持循环引用时返回部分初始化的 `module.exports`。

缓存键与 `__filename` 按来源区分：文件系统模块用 `realpath` 后的绝对路径；内建与
构建期清单模块（`jsModuleSource=embedded` 时没有文件路径）用模块 id 本身
（如 `"fs/promises"`、`"skyjs/fsx"`），此时 `__filename` 即模块 id、`__dirname`
为 id 的目录部分，内建模块内的相对 `require` 按 id 路径解析。

### 9.2 解析规则

初始支持：

- 相对路径。
- 绝对路径。
- `.js`
- `.json`
- 目录入口，含 `package.json` 的 `main`、`index.js` 或 `index.json`。
- 内置模块与 `node:` 前缀别名，模块 id → 实现的映射见 §3 的表，唯一定义处是
  `js/internal/module-registry.js`。
  - Node 面 id（`fs`、`http`、`child_process`…）解析到 `js/builtins/<name>`。
  - `skyjs/<name>[/<subpath>]` 先查 `js/builtins/skyjs/<name>`；未收录时回退到
    `node_modules/@skyjs/<name>` 的对应子路径（§3.1）。回退只查 `@skyjs` 作用域。
  - `js/internal/*` 只允许 `js/builtins/**` 与 `js/internal/**` 内部解析；业务与
    插件请求该前缀一律抛 `ERR_PERMISSION`，不是"文件不存在"。
- 基础 `node_modules` 查找：
  - 从当前模块目录逐级向上查找 `node_modules/<package>`。
  - 支持包名、`@scope/name` 与包内子路径的基本查找。
  - 支持 `package.json#main`；缺失或不可解析时回退 `index.js` / `index.json`。
  - 支持目录下 `index.js` / `index.json`。
  - 暂不处理 `package.json#exports`、`imports`、conditions 与多版本语义。

### 9.3 延后项

- 完整 `node_modules` 解析与多版本解析。
- `package.json#exports`、`imports` 与 conditions 映射。
- ESM 加载、`package.json#type: module` 与 CJS/ESM 互操作。
- Node N-API / node-gyp 原生 addon；SkyJS 自有的 cservice 原生形态不属于延后项，
  见 §3.2。
- Node 的完整模块缓存失效语义。

## 10. 内置模块

| 模块 | 批次 | 说明 |
|---|---|---|
| `events` | NC0 | EventEmitter 基础语义 |
| `console` | NC0 | 映射 skynet 日志通道；同时经全局 `console` 暴露（§3） |
| `buffer` | NC0（全局）/ NC1（`require`） | `Buffer` 构造器与 `Blob`/`File`/`constants`；全局 `Buffer`/`Blob`/`File` 由其提供。内核 NC0 随全局装配落地，`require('buffer')` 入口 NC1 补齐 |
| `util` | NC1 | promisify、callbackify、format、types 等 |
| `path` | NC1 | 平台路径语义 |
| `url` | NC1 | WHATWG URL 与 legacy url |
| `querystring` | NC1 | 常用编解码 |
| `os` | NC1 | `platform`/`arch`/`tmpdir`/`homedir`/`endianness`/`EOL`/`cpus` 等稳定子集；`type`/`release`/`hostname` 取宿主值，数据源 `skynetcore.runtime.info()` |
| `fs/promises` | NC2 | 完整 Node 20 API，首版必交付 |
| `fs` | NC2 | 完整 Node 20 API（callback/sync/Promise） |
| `stream` | NC2 | Readable/Writable/pipe/背压基础，`fs` 流依赖 |
| `stream/promises` | NC3 | `pipeline`/`finished` 的 Promise 形式 |
| `child_process` | NC3 | 映射到 SkyJS subprocess |
| `crypto` | NC4 | 映射到 SkyJS crypt 扩展 |
| `zlib` | NC4 | 映射到 SkyJS crypt 压缩能力 |
| `net` | NC4 | `Socket`/`Server`/`connect`/`listen`/`timeout`，复用 `internal/net-core` |
| `tls` | NC4 | Node 常用子集，复用 `skynetcore.tls`；不做完整证书链生态 |
| `http` / `https` | NC4 | Node 常用子集；不承诺 Express 无改动运行 |
| `fetch`（全局，非模块） | NC4 | 经 `internal/http-core` 实现；对外不暴露 `httpc` |

“批次”列与 §13 的 NC0–NC4 一一对应，是唯一的排期口径；本表与 §13、§16.12 冲突
时以 §13 为准。

`fetch`、`WebSocket`、`structuredClone` 不是可 `require` 的内置模块，按 §3 的规则在
能力落地后再挂到 `globalThis`，不提前占名。

### 10.1 “支持 Express 生态”指什么

Express 不是单个模块，而是一组对 Node 运行时行为的组合依赖。要让现有 Express
应用无改动运行，至少需要：

- `http.createServer`、`http.Server`、`IncomingMessage`、`ServerResponse` 的完整
  生命周期与事件语义。
- `req`/`res` 作为 `Readable`/`Writable` 流工作：`pipe`、`on('data')`、`on('end')`、
  背压、`writeHead`/`setHeader`/`end` 等。
- `net.Socket`、keep-alive、超时、连接关闭与错误传播语义。
- 依赖上述行为的大量中间件：`body-parser`、`cookie-parser`、`compression`、
  `serve-static`、`multer`、`express-session` 等。

所以“支持 Express 生态”不等于实现 `http.request`，而是要求 Node `http` + `net` +
`stream` 足够兼容，能让 Express 及其中间件不改代码运行。工作量和风险都明显高于
SkyJS 自带 `webapp` 框架。

决策（ND-7）：首版不承诺 Express 无改动运行；HTTP 先实现常用 Node `http`/`https`
子集，应用层优先使用 `webapp`。Express 兼容作为独立的后续里程碑，并以真实
Express 应用与中间件矩阵作为验收标准。

### 10.2 `child_process` 与 `skyjs/subprocess`

**决策：`child_process` 由 SkyJS `skyjs/subprocess` 基建实现，不另起宿主级进程接口。**

Node 的 `child_process` 只定义 JS 侧接口，底层拉起进程、管理 stdio、等待退出与
回收孤儿的能力，正好落在 [infra/06-subprocess.md](infra/06-subprocess.md) 已经
规划的分层上：

```text
Node child_process facade
  │
require('skyjs/subprocess') 客户端库
  │
.subprocess owner service
  │
skynetcore.subprocess（POSIX posix_spawn / Windows CreateProcess）
```

初始支持范围：

- `spawn` / `spawnSync`：映射 `subprocess.spawn`，`stdio` 支持
  `pipe`/`ignore`/`inherit`；返回的 `ChildProcess` 暴露 `pid`、`stdin`、`stdout`、
  `stderr`、`on('exit'|'close'|'error')`、`kill`。
- `exec` / `execFile`（含 `Sync` 变体）：映射 `subprocess.exec`，支持 `maxBuffer`、
  `timeout`、`signal`、`cwd`、`env`、`encoding`。
- `kill` 与退出信息：`code`、`signal` 按 Node 语义给出；SkyJS 内部错误分类放在
  `err.detail`，不替换 `err.code`。
- `ChildProcess` 的 stdin/stdout/stderr 复用 `stream` 的 `Readable`/`Writable`，
  与 `fs` 流共享背压与取消语义。

约束与延后项：

- `fork` 后置：它依赖可复用的 Node 运行时入口与 IPC channel，成本高于普通进程
  派生，首个版本不实现。
- `shell: true` 需显式解析 shell 与参数转义，默认不隐式经 shell，避免命令注入。
- 进程数量、输出大小、超时、并发由 `.subprocess` owner 统一按调用方配额限制
  （见 infra 06 的 `maxOutput`/`maxProcessesPerPlugin`）。
- 移动端构建不编入 `subprocess`；调用抛 `ERR_UNSUPPORTED_PLATFORM`。
- `child_process` 必须经过插件宿主权限校验，不能成为绕过沙箱启动任意程序的通道。

## 11. Actor 与插件安全

- Node 兼容层不提供绕过 SkyJS 权限模型的入口。
- 插件 VM 只获得 manifest 与白名单允许的 Node 全局对象与内置模块。
- `node:` 前缀不作为权限提升通道。
- 插件 VM 不暴露完整 `process` 对象；如确需兼容，只提供受限 facade，并禁用
  `process.exit`、`process.kill` 等宿主级能力。
- 插件 VM 内禁止访问 `skynetcore.*`、`js/internal/*`，以及除白名单外的任何 Node
  内置模块（`fs`、`net`、`child_process`…）；能力一律经 `skyjs/pluginHost` 的
  host bridge 暴露（见 infra 09）。
- `child_process` 必须经过插件宿主权限校验与进程配额。
- 文件访问必须经过路径边界与权限校验。
- 网络访问必须遵循 `net` 与 `net:insecure-tls` 权限。
- 取消、超时与资源清理优先级高于 Node 语义的完整复刻。

## 12. 一致性测试与差异记录

测试应覆盖以下维度：

- Node 20 LTS API 行为对照。
- CommonJS 模块解析与循环引用。
- 基础 `node_modules` 查找、`package.json#main` 与目录入口。
- 定时器与 microtask 顺序。
- `process.nextTick` 先于 Promise microtask 的优先级。
- 完整 `fs` API 与 Node 20 对照（callback/sync/Promise、`FileHandle`、流、watch）。
- `fs` 权限拒绝、路径边界、错误码与取消后的资源回收。
- `Buffer.allocUnsafe` 返回零初始化内容。
- `process` 成员表：未实现成员为 `undefined`，`stdin` 为 `null`，`exitCode` 影响正常关停的退出码。
- `process.exit()` 以指定退出码退出宿主进程。
- `process.exit()` 在 `try/catch` 内被拦截时仍保证退出码生效，且不再执行后续回调。
- `process.env` 写入只影响当前 Actor。
- 文件、子进程、网络与流的取消后资源回收。
- `child_process` 到 `subprocess` 的映射：stdio、退出码/signal、配额与移动端不可用。
- 插件 VM 的权限隔离。
- 恶意路径、超配额与异常资源访问。
- 与既有 SkyJS 测试套件的回归。

### 12.1 已确认的兼容差异

下表是当前**已确认且必须记录**的差异，实现时不得静默改变；新增差异必须先补本表
再改代码。差异表本身由 `test/node-compat/` 的用例逐条覆盖。

| 差异 | Node 20 行为 | SkyJS 行为 | 理由 |
|---|---|---|---|
| `process.exit()` 中途打断 | 立即结束进程，`try/catch` 无法拦截 | 写退出码 + `ABORT` + 抛内部哨兵；用户 `try/catch` 可拦截哨兵，但退出码生效且不再执行后续回调 | QuickJS 没有不可捕获异常（ND-19） |
| `Buffer.allocUnsafe` 内容 | 不保证，可能是陈旧内存 | 保证零初始化 | 避免跨 Actor 内存泄露（ND-8） |
| `SlowBuffer` | 存在（已废弃） | 不实现 | Node 已废弃（§7.1） |
| `buffer.transcode()` | 依赖 ICU 的编码转码 | 抛 `ERR_UNSUPPORTED_PLATFORM` | QuickJS 无 ICU（§7.1） |
| `Buffer.poolSize` | 池化阈值可调 | 保留字段但不池化 | 零初始化约束下不引入池化（§7.2） |
| 定时器精度 | 毫秒级，通常亚毫秒触发 | 10 ms 粒度，向上取整 | `skynet.timeout` 的 10 ms 单位 |
| `setImmediate` 与 `setTimeout(0)` 相对顺序 | 不保证 | 固定 immediate 先（§16.7 tick 顺序） | Node 未定义顺序，SkyJS 取固定顺序避免抖动（§5.2） |
| `process.cwd()`/`chdir()` | 进程级 cwd | Actor 局部 cwd，`chdir()` 抛 `ERR_UNSUPPORTED_PLATFORM` | 进程级 cwd 与 Actor 隔离冲突 |
| `process.env` | 进程级可变环境 | 宿主 environ 的 Actor 局部快照；写入不影响宿主与其他 Actor；快照后宿主 `setenv` 不反映 | 进程级环境与 Actor 隔离冲突 |
| `process.argv` | 宿主进程 argv | Actor 局部 argv | 同上 |
| `process.stdin` | 可读流 | `null` | Actor 模型下无统一控制台输入（§4.5） |
| `os.*`/`fs.*` 平台缺失能力 | 平台原生行为 | 抛 `ERR_UNSUPPORTED_PLATFORM` 或按 Node 平台语义抛 `ENOSYS`，不改静默降级 | 平台差异需显式可见 |
| ESM | 支持 | 不支持，仅 CommonJS | ND-2 |
| `node_modules` | 完整解析（`exports`/`imports`/conditions） | 基础解析（`main`/`index`），不支持 `exports` 映射 | ND-3 |
| Express 生态 | 可运行 | 首版不承诺，Node `http`/`https` 只做常用子集 | ND-7 |
| `watch` 事件粒度 | 原生 watcher 语义 | 受平台限制，不支持时抛错并记录 | 平台能力差异（§8） |

## 13. 实施批次

首版发布门禁为 NC0–NC2，其中 NC2 的完整 `fs` 不允许拆分后置。NC3/NC4 在首版门禁
之后按批次推进；它们即使提前完成，也不改变首版门禁的定义。

各批次的子批拆分、文件级任务、验收命令与提交策略见
[node-compatibility-plan.md](node-compatibility-plan.md)（执行计划；本文仍是架构
与出口标准的唯一定义处）。

插件宿主（`service/plugin-manager.js`、`skyjs/pluginHost`、snplugin loader）属
[infra/09-plugin-host.md](infra/09-plugin-host.md) 的独立线，不在 NC0–NC5 排期；
§11 的插件安全约束随该线落地而生效，不阻塞首版门禁。在此之前，§16.4.4 "引擎
`service/` 恰好 3 个文件" 的计数按 2 个执行（`.fs` 与 `.subprocess`）。

### NC0

- 交付：`js/loader.js` + `js/bootstrap.js` + 构建期模块清单；CJS 包装器、缓存、
  循环引用、`js/internal/*` 与 `skyjs/*` 的模块 id 解析；`process` 核心（含
  `exit` 与 §4.5 成员表）、`internal/abort`、`internal/text-codec` 与全局装配、
  `events`；`internal/event-loop` 统一 tick 入口。`Buffer` 内核以
  `js/internal/buffer-core.js` 形式在本批落地并作为全局 `Buffer` 暴露；
  `require('buffer')` 入口在 NC1 补齐（含 `Blob`/`File`）。
  `skynetcore` 按 §16.5 分组重命名（`io`→`fs`、`socket`→`net`、
  `pack`/`unpack`/`str`→`seri`，新建 `js-runtime.c` 提供 `runtime.*`）与
  `skynet.features()`（infra/01 §5）同批完成——两者一次性触碰所有 facade，
  必须在后续批次铺开前收敛。现有 `js/*.js` 全部改为 require 形态（过渡形态见
  §16.11）；`js/skyjs.d.ts` 开始拆分为 `js/types/*.d.ts`，随各模块批次同步补齐。
- 出口：现有 `test/config-*.json` 全部迁移到 `require` 入口且不回归；纯定时器程序
  能自行推进（不依赖外部消息）；`process.exit(3)` 能以 3 退出宿主。

### NC1

- 交付：基础 `node_modules` 查找；`buffer`（含全局 `Blob`/`File`，
  `fs.openAsBlob` 的前置）；`path`/`util`/`url`/`querystring`/`os`；
  `internal/errors` 的 Node errno/code 构造与映射表；`internal/binary-frame`
  二进制通道（§16.12 顺序 4 的"NC1 收尾"由此落实）；`skyjs/log` 与
  `skyjs/testing` 两个内建入口。
- 出口：`test/unit/` 纯逻辑用例 `node --test` 通过（单侧运行，Node 即真值，
  §16.10）；`path`/`querystring`/`url`/`errors` 等 Node 面向用例落
  `test/node-compat/`，在 Node 20 与 SkyJS 两侧对拍一致；`node_modules` 查找
  覆盖包名、`@scope/name`、子路径与 `package.json#main`；`require('buffer')`
  与全局 `Buffer`/`Blob`/`File` 是同一实现的两个入口。

### NC2

- 交付：`internal/stream-core` + `require('stream')` facade；`internal/fs-core` +
  `service/fs-service.js`（`.fs`）+ `internal/permission.js` 权限层（`internal/binary-frame` 已于 NC1 交付，本批直接使用）；完整
  `fs`：callback/sync/Promise、`fs/promises`、`FileHandle`、
  `createReadStream`/`createWriteStream`、`watch`/`watchFile`、
  `constants`/`Stats`/`Dirent`。
- 出口：Node 20 `fs` 公开 API 逐项对照通过（`test/node-compat/`）；1 GiB 流经
  `pipe` 时 JS 堆增量 < 64 MB（`skynetcore.runtime.mem()` 计量）；权限拒绝与取消后 fd 无泄漏。**本批不允许只交
  `fs/promises` 而把 callback/sync 后置。**

### NC3

- 交付：`stream/promises`（`pipeline`/`finished`）；`service/subprocess-service.js`
  （`.subprocess`）+ `service-src/js-subprocess.c` + `require('child_process')` facade。
- 出口：`spawn`/`exec`/`execFile` 的 stdio、退出码/signal、超时与取消对拍 Node；
  取消后无孤儿进程；移动端构建里该模块不编入且 `features().subprocess.available`
  为 `false`。

### NC4

- 交付：`internal/net-core`（合并 `js/socket.js` + `js/sockethelper.js`；
  `skynetcore.net` 重命名已于 NC0 完成）；`internal/http-core` 与 `require('http')`/`https`；
  `require('net')`/`tls`；`internal/crypt-core` 与 `require('crypto')`/`zlib`；
  全局 `fetch`。
- 出口：`http` server/client 常用子集对拍 Node；keep-alive 与断连取消的 fd/内存
  长跑稳定；`fetch` 经同一内核实现且不暴露 `httpc`。

### NC5（可选，非首版门禁）

- 交付：`service-src/js-native.c` 的
  `skynetcore.native.enabled/dynamicEnabled/staticEnabled/resolve/find/load/abi/init/initStatic/unload/errmsg`
 原语（§3.4.5；`staticEnabled` 供 `features()` 报告静态路径可用性，
  `errmsg` 供 loader 统一拼 `dlopen`/`dlsym` 失败文案）+
  `js/internal/native-loader.js` + `extpath` 配置键 +
  `package.json#skyjs.native`（字符串或平台键值表）解析 + 静态构建的符号改写与
  `native-registry.c` 生成（§3.4.3、§3.4.5）；公开能力由具体扩展包提供
  （`features()` 按包注册能力键）。
- 出口：一个示例扩展（如 `@skyjs/example-native`）按 `skyjs.native` 声明动态
  装载、`extpath` 非空时在 `require` 时调用 `skyjs_ext_init`，与手写 C 桥
  （`register_crypto_bridge` 家族）行为一致；平台键缺失时抛
  `ERR_UNSUPPORTED_PLATFORM`，`skyjs_ext_abi()` 缺失或不匹配时明确报错。未编入
  `NATIVE_EXT=1`、或静态表未命中且 `extpath` 为空时，`require` 抛
  `ERR_UNSUPPORTED_PLATFORM`；插件 VM 调用返回 `ERR_PERMISSION`。另需各验一遍
  动态路径（`extpath` 非空 + `.so`）与静态路径（`extpath` 为空 + 静态登记）都能装载。
- 待验证：确认扩展 `.so` 在 `RTLD_LOCAL` 下能解析主程序导出的 QuickJS 符号
  （三平台各验一次），结论写回 §3.4.3。

## 14. 决策记录

| ID | 问题 | 方案 | 状态 |
|---|---|---|---|
| ND-1 | `process.exit()` 退出当前 Actor 还是宿主进程 | 退出宿主进程，`code` 作为宿主退出码 | 已确认 |
| ND-2 | 初始是否支持 ESM | 先只支持 CommonJS，ESM 后期实现 | 已确认 |
| ND-3 | 初始 `node_modules` 支持范围 | 先实现基础版；完整解析后续补充 | 已确认 |
| ND-4 | 是否引入 `nodeCompat` 配置开关 | 不引入；Node 兼容面由 loader 默认注入，插件 VM 单独白名单 | 已确认 |
| ND-5 | `process.nextTick` 与 Promise microtask 的优先级 | 运行时独立 nextTick 队列；tick 边界先于 Promise microtask，microtask 内新增的 nextTick 等当前 microtask 清空后执行 | 已确认 |
| ND-6 | 首版 `fs` 支持范围 | 完整覆盖 Node 20 `fs` 公开 API；NC2 一次性交付 | 已确认 |
| ND-7 | 是否承诺 Express 无改动运行 | 首版不承诺；先做 Node `http`/`https` 常用子集，应用层用 `webapp` | 已确认 |
| ND-8 | `Buffer.allocUnsafe` 初始是否零初始化 | 初始零初始化，避免陈旧内存泄露；后续池化再评审 | 已确认 |
| ND-9 | `child_process` 如何实现 | 由 `subprocess` 客户端库 + `.subprocess` owner service 承载；`fork` 后置 | 已确认 |
| ND-10 | 现有 `io`/`http`/`websocket` 等库是否重构 | 允许重构；改为 CommonJS 模块格式，全局注入收敛到 Node 规范全局 + `skynet`（§16） | 已确认 |
| ND-11 | `globalThis.fs` 归属（infra/05 自有 API vs Node 语义） | Node 语义经 `require('fs')`；自有流式 API 改名 `require('skyjs/fsx')`，不再占用 `globalThis.fs` | 已确认 |
| ND-12 | `stream` 是否同时提供 Node 类语义与自有工厂 API | 由 `internal/stream-core` 统一承载，`require('stream')` 与 `skyjs/*` 各自适配 | 已确认 |
| ND-13 | `process.version` 报告值 | 报告对标的 Node 版本（20.x），不是 SkyJS 版本 | 已确认 |
| ND-14 | CommonJS 是否作为运行时自身模块格式（不只用户代码） | 是；`js/` 源码改用 `require`，移除 `lazy_setup_js` 全局表 | 已确认 |
| ND-15 | 目录结构 `js/internal` + `js/builtins` + `service/` | 采纳 §16.4 | 已确认 |
| ND-16 | `skynetcore` 是否按能力分组（`skynetcore.fs`/`net`/`seri`/`runtime`） | 采纳 §16.5 | 已确认 |
| ND-17 | 引擎缺失的 Web 标准全局（`TextEncoder`/`TextDecoder`、`AbortController`/`AbortSignal`）如何提供 | QuickJS-ng 均不内置；由 `js/internal/` 提供 WHATWG 对齐 polyfill，Node 全局与 `skynet.abortController()` 共用同一实现 | 已确认 |
| ND-18 | `process` 对象实现到什么程度 | 按 §4.5 的成员表实现；表外成员为 `undefined`，`stdin` 为 `null`，信号与 uid/gid 系列不实现 | 已确认 |
| ND-19 | `process.exit()` 如何在 QuickJS 中打断当前回调链 | 写退出码 + 触发 ABORT + 抛内部哨兵异常，运行时边界吞掉；QuickJS 无不可捕获异常，用户 `try/catch` 可拦截哨兵，但退出码与"不再执行后续回调"仍保证 | 已确认 |
| ND-20 | `os` 模块是否进入初始范围 | 进入 NC1：交付 `platform`/`arch`/`tmpdir`/`homedir`/`EOL` 等稳定子集，数据源与 `process` 共用 `skynetcore.runtime.info()` | 已确认 |
| ND-21 | `skyjs/media`、`skyjs/tag` 这类模块是否走 `node_modules` | **可以走**。`skyjs/*` 是保留说明符命名空间；解析为"内建表优先，未收录则回退 `@skyjs/<name>` 包"。内建发行与 npm 分发并存，按模块逐项选型（§3.1） | 已确认 |
| ND-22 | 多文件的模块用单文件还是目录形式 | 用目录形式：内建为 `js/builtins/skyjs/<name>/index.js`，包为 `packages/<name>/index.js` + 子文件（与 Node 面多文件模块同约定）。首版 8 个内建入口均为单文件；后续若拆多文件改目录形式，入口名不变（§16.11）；`media`/`tag`/`webapp`/`db`/`archive` 等包均属此类 | 已确认 |
| ND-23 | 长驻原生模块（`media`/`tag` 的 owner 部分）如何随 npm 包分发 | 走 cservice ABI，三种形态：预编译 `.so`（cpath 可指向 `node_modules`）、静态库（构建期链入，用于移动端）、随包携带 C/C++ 源码（构建期编译）。不采用 N-API/node-gyp 路线（§3.2） | 已确认 |
| ND-24 | 内建发行与 npm 分发的选择原则 | 两者都支持，按模块选型；默认构建/移动端/需 `features()` 精确报告时优先内建；独立迭代/按需安装时用 `@skyjs/<name>`。`skyjs/*` 入口名始终保留（§3.1） | 已确认 |
| ND-25 | npm 分发的 facade 与原生 ABI 版本如何约束 | `peerDependencies` 锁定运行时版本区间；原生产物带 ABI 版本号运行时校验；`features()` 区分"包未安装"与"能力未编入"（§3.3） | 已确认 |
| ND-26 | cservice 加载器能否顺带加载普通 `.so` | 不能。cservice 必需 `<name>_create`/`_init`/`_release`/`_signal` 四入口，且加载结果是 Actor 服务。"JS 直接调用 C 代码"是另一件事，走 §3.4 的 C 桥模块 | 已确认 |
| ND-27 | "JS 调用 C 代码"用什么形态 | 采纳 **C 桥模块**，参照 `register_openssl_crypto`：C 侧手写函数 + `JS_NewCFunction` 挂到对象上。首方能力编进 `snjs.so`（`register_*_bridge`）；第三方包导出 `JSValue skyjs_ext_init(JSContext *, JSValueConst ns)` + `int skyjs_ext_abi(void)`，按 `package.json#skyjs.native`（`extpath` 非空时）动态装载或构建期静态链入。**不是 FFI**（§3.4） | 已确认 |
| ND-28 | 是否为省去包装而提供通用 FFI（libffi + 签名表） | 不提供。实际要的是"JS 调到我们写的 C 函数"，C 桥已覆盖；FFI 只省包装工作量，却引入签名类型系统、绕过内存记账、ABI 不匹配即段错误。也不保留 `dlsym` 诊断口子（§3.5） | 已确认 |
| ND-29 | C 桥模块是否都做独立 `.so` + `extpath` | 否。首方 C 桥仍编进 `cservice/snjs.so`（`register_<name>_bridge()` 直接调用，零加载开销、无 ABI 错配）；只有第三方独立迭代的能力走独立 `.so` + `extpath` + `skyjs_ext_abi` 校验（§3.4.2–3.4.3） | 已确认 |
| ND-30 | 运行时是否提供"加载任意普通 `.so`"的能力 | 不提供。普通 `.so` 没有 `skyjs_ext_init`，也没有类型信息；需要时由 C 桥扩展在 C 侧 `dlopen` / `dlsym` 并按函数指针类型调用，类型与生命周期责任留在扩展内。运行时只认 `skyjs_ext_abi` / `skyjs_ext_init` 两个符号（§3.4.1） | 已确认 |
| ND-31 | 静态路径与动态路径是"二选一开关"还是"静态优先、动态兜底" | 静态优先、动态兜底。`extpath` 只约束动态这一步，为空时静态登记的包照常可用；`skynetcore.native.enabled()` 只表示编入了 `NATIVE_EXT=1`，两条路径的可用性另由 `dynamicEnabled()`（`enabled()` 且 `extpath` 非空）与 `staticEnabled()`（`enabled()` 且静态表非空）分别表示（§3.4.3、§3.4.5） | 已确认 |
| ND-32 | `skynetcore.native.*` 是否构成 §3.5 禁止的"任意符号调用"口子 | 不构成，且不必为此加沙箱。它是"只加载"而非"任意调用"：`abi()`/`init()` 的符号名写死为 `skyjs_ext_abi`/`skyjs_ext_init`，无原语接受调用方给的符号名，也不把符号地址交给 JS（`handle` 不透明）。它挂在 `skynetcore` 全局下、无公开模块入口，对受信服务脚本可见但对插件 VM 不可见；"仅 loader 调用"是契约约定而非沙箱边界（§3.4.5、§3.5） | 已确认 |
| ND-33 | 哪些 `skyjs/*` 入口内建、哪些走 `@skyjs` 包 | 引擎只内建 8 个承重入口：`fsx`/`subprocess`/`crypt`（与层 1 模块共用 owner/内核）、`cluster`/`gateserver`（Actor 运行时契约）、`pluginHost`（插件安全边界）、`log`/`testing`（直接绑引擎原语）。其余 `webapp`/`websocket`/`archive`/`config`/`metrics`/`db`/`media`/`tag` 一律落 `packages/<name>/`，发布为 `@skyjs/<name>`，loader 按 §3.1 回退解析。判据见 §16.4.1，引擎逐目录/逐文件清单见 §16.4.2，逐包实现清单见 §16.4.3.1，落码前的边界检查清单见 §16.4.4；“删掉 `packages/` 引擎仍可构建启动”是收口标准。包只依赖 L4 公开面，不得 `require('js/internal/*')` 或直接调 `skynetcore.*` | 已确认 |
| ND-34 | `process.env` 的数据源 | 宿主进程 environ 在服务启动时刻的 Actor 局部快照；skynet 配置键不进入，仍走 `skynet.getenv`（§4.2） | 已确认 |
| ND-35 | `buffer` 覆盖面 | 与 `fs` 同口径完整覆盖 Node 20 公开 API；`SlowBuffer`/`transcode`/`poolSize` 例外记差异表（§7.1、§12.1） | 已确认 |
| ND-36 | `fs.watch` 事件如何投递 | C 侧 watcher 线程跑平台机制（macOS kqueue `EVFILT_VNODE`，Linux 预留 inotify），事件经 skynet 消息队列注入 `.fs` owner，不改内核事件循环（§8） | 已确认 |
| ND-37 | loader 与 bootstrap 的自举顺序 | C 侧以非模块脚本装载 `js/loader.js`，再由 loader `require('js/bootstrap.js')`；loader 不经 `require` 加载自身（§3、§16.3） | 已确认 |
| ND-38 | 插件宿主是否进 NC 批次 | 不进；属 infra/09 独立线，§11 的插件安全约束随其落地生效，不阻塞首版门禁（§13） | 已确认 |

## 15. 现状缺口盘点（相对 §16 目标架构）

本节只做"现状 vs §16 目标"的差距清单，供排期使用；**架构与命名以 §16 为准**，
本节不重复定义设计。读者若要了解目标形态，直接看 §16。

先对齐现状（以仓库实际代码为准，不是 infra 文档的规划态）：

- `service/` 目录**尚不存在**；唯一的异步 owner 是 [js/ioservice.js](../js/ioservice.js)，
  而且它放在 `js/` 下，不是 01-conventions 约定的 `service/<cap>-service.js`。
- `skynetcore.io`（[service-src/js-io.c](../service-src/js-io.c)）只有 16 个**同步**原语：
  `readFile`/`writeFile`/`appendFile`/`str2ab`/`exists`/`stat`/`readdir`/`mkdir`/
  `remove`/`rename`/`open`/`fread`/`fwrite`/`fseek`/`ftell`/`fclose`。底层直接
  `fopen`，**没有 errno、没有权限边界、没有 fd 语义**。
- 没有 `stream`、`events`、`Buffer`、`process`、定时器、`AbortSignal`/`AbortController`
  的独立库；`TextEncoder`/`TextDecoder` 只有 [js/skynet.js](../js/skynet.js) 里的
  最小 polyfill。
- 加载器已完成 NC0.8 收口：`snjs.c` 的 `lazy_setup_js`/`__snjs_lazy_paths` 与逐库
  字节码表已删除，C 侧只把 `js/loader.js` 当普通脚本装载，其余由 `js/bootstrap.js`
  以 require 装配；`worker_cb` 的 pending-job drain 统一走 `internal/event-loop`
  （nextTick → microtask → immediate → timer）。
- 没有 `.fs`、`.subprocess` owner service，没有 `skynetcore.subprocess`，没有统一
  权限/配额层，没有插件宿主（`.pluginManager`）。
- `skynetcore` 旧扁平名与旧全局注入（`io`/`httpd`/`httpc`/`httpInternal`/
  `socket`/`sockethelper`/`websocket`/`crypt`/`cluster`/`gateserver`）已随 NC0.8
  全部删除，只剩 `runtime`/`fs`/`net`/`netpack`/`seri`/`crypt`/`tls` 分组。
- `skynet.features()` 已随 NC0.3 落地；能力表仍会随后续批次逐步填充。
- `process.exit()` 的宿主退出通道已随 NC0.5 落地（退出码经
  `platform/runtime-exit.c` 回传）。

与 §13 批次的对应关系：NC0 覆盖模块系统/事件循环/`process`/`Buffer`/定时器；
NC1 覆盖纯 JS 模块与错误层；NC2 覆盖流与完整 `fs`；NC3 覆盖子进程；NC4 覆盖
网络、HTTP 与密码学。命名分组（`skynetcore.*`）与 `features()` 是横切项，随 NC0
起步并在此之前完成，因为它们会一次性触碰所有 facade。

### 15.1 NC0：运行时底座

| 缺口 | 现状 | 需要做的事 |
|---|---|---|
| CommonJS 模块系统 | 只有整段 `JS_Eval` 的全局脚本模式 | 新增模块包装器（`module`/`exports`/`require`/`__filename`/`__dirname`）、按 `realpath` 索引的缓存、解析器与循环引用处理；`require` 必须保持模块局部变量 |
| `process` | 不存在 | 新建 `process` 对象，成员范围以 §4.5 表为准；`env` 取宿主 environ 的 Actor 局部快照（§4.2），`argv` 从服务启动参数构造，`exit(code)` 走宿主退出 |
| `Buffer` | 不存在 | `Uint8Array` 子类 + Node 20 公开 API 全覆盖（例外见 §7.1）；`allocUnsafe` 首版零初始化；NC0 先供全局，NC1 补 `require('buffer')` |
| 定时器 | 只有协程式 `skynet.timeout`/`skynet.sleep` | 新增回调式 `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`，并定义与服务退出、取消的联动 |
| nextTick 队列 | 与 Promise 共用 QuickJS job 队列 | JS 侧独立队列 + C 侧 drain 钩子（见 §5.3） |
| 事件循环驱动 | microtask 只在 `worker_cb` 收到消息时被 drain | 定时器到点、流事件、socket 事件等非消息来源也必须进入统一的 tick 入口，否则纯定时器/流程序会"卡住不推进" |
| `events` | 没有 | NC0 交付 `EventEmitter` |
| `util`/`path`/`url`/`querystring`/`buffer`/`os` | 都没有 | NC1 纯 JS 可写；`path`/`os`/`buffer` 依赖 `skynetcore.runtime.info()`（§4.5 的 `platform`/`cwd`、`os.tmpdir`/`homedir`） |
| `TextEncoder`/`TextDecoder`、`AbortController`/`AbortSignal` | 只有 `js/skynet.js` 里的最小内联 polyfill，无 Abort 实现 | 抽到 `js/internal/text-codec.js` 与 `js/internal/abort.js`，NC0 随全局装配一起落地 |

### 15.2 NC1–NC2：文件与流

| 缺口 | 现状 | 需要做的事 |
|---|---|---|
| `stream` 库 | 不存在；`sockethelper.js` 的 `BufferedReader` 不是通用流 | 新建 `js/internal/stream-core.js`：可读/可写/pipe/取消/credit 背压，作为 `fs` 流、`child_process` stdio、HTTP 的共同底座 |
| `.fs` owner service | 只有 `js/ioservice.js` + base64 RPC | 新建 `service/fs-service.js`，RPC 改为二进制 envelope（见下） |
| `skynetcore.fs` 原语 | 只有整文件同步读写 | 补 `ftruncate`/`fsync`/`fdatasync`/`realpath`/`chmod`/`fchmod`/`fchown`/`futimes`/`symlink`/`readlink`/`mkstemp`/`statvfs`/`readv`/`writev` 及 `watch` 的原生 watcher |
| 跨 service 二进制传输 | js-seri 不能 round-trip `ArrayBuffer`，异步 fs 走 base64 | 落地 infra 02 的 `frameEncode`/`frameDecode`（长度前缀 + 二进制体），否则完整 `fs` 与流会在大文件上退化 |
| 错误映射所需信息 | C 原语抛的是文本 `TypeError`，没有 errno | C 侧返回 errno（或 `errno`+`syscall`+`path` 结构化错误），JS 侧据此构造 Node 风格 `err.code`/`errno`/`syscall`/`path` |
| 权限与配额 | C 层直接 `fopen`，无路径边界 | 新增 `js/internal/permission.js`（路径边界/配额/能力授权的纯逻辑判定），`.fs`/`.subprocess` owner 与插件宿主共用；拒绝映射 `EACCES`/`EPERM`；Node 兼容不得绕过 |

### 15.3 NC3：子进程

| 缺口 | 现状 | 需要做的事 |
|---|---|---|
| `skynetcore.subprocess` | 完全不存在 | 新建 `service-src/js-subprocess.c`：`spawn`/`wait`/`kill`/管道 read/write/close（见 infra 06） |
| `.subprocess` owner service | 不存在 | 新建 `service/subprocess-service.js`：独占进程句柄、stdio 读循环、并发配额、取消/超时后 kill 与孤儿回收 |
| `child_process` facade | 不存在 | 在 `subprocess` 之上做 Node 语义（`spawn`/`exec`/`execFile`/`kill`，`fork` 后置），见 §10.2 |
| 平台开关 | 无 | 移动端不编入该模块，`features().subprocess.available === false` |

### 15.4 NC4：网络

| 缺口 | 现状 | 需要做的事 |
|---|---|---|
| Node `stream` 类语义 | 工厂式流内核已有规划，但与 Node 类语义不完全一致 | 按 ND-12 由 `js/internal/stream-core.js` 统一承载；`js/builtins/stream/` 适配出 `Readable`/`Writable`/`Duplex`/`Transform`/`pipeline`，`skyjs/*` 使用内核工厂 API（见 §16.6） |
| `require('net')` | 只有 `globalThis.socket` + skynet socket 消息模型 | 新增 Node `net` facade：`Socket`/`Server`/`connect`/`listen`/`timeout`，复用 `js/internal/net-core.js`（合并自 `js/socket.js` 与 `js/sockethelper.js`）与 `skynetcore.net` |
| `require('http')`/`https` | 只有 `httpd`/`httpc`/`httpInternal` | 新增 facade：`createServer`/`Server`/`IncomingMessage`/`ServerResponse`/`request`，复用 `js/internal/http-core.js` 协议解析，补流语义与 keep-alive |
| 长连接事件驱动 | 服务是消息驱动 + `skynet.start` 模型 | `server.listen()` 这类 Node 入口需要一个"服务保活 + 事件泵"适配层，把 skynet socket 消息接到 Node 风格回调；否则 Node 服务写不出可运行的主循环 |
| `fetch` 映射 | 有 `httpc` 客户端能力 | 新增 `js/builtins/fetch.js`，内部复用 `js/internal/http-core.js`；`httpc` 作为旧全局随重构移除 |
| `crypto`/`zlib` | 有 `crypt`，无 `zlib` | 抽 `js/internal/crypt-core.js`，`require('crypto')` 与 `skyjs/crypt` 各自适配；`zlib` 需在 `skynetcore.crypt` 或独立 C 模块补压缩原语 |

### 15.5 横切能力

| 缺口 | 说明 |
|---|---|
| `AbortSignal`/`AbortController` | QuickJS-ng 不内置，由 `js/internal/abort.js` 提供 WHATWG 对齐 polyfill（infra 01 §6 已约定）；`skynet.abortController()` 与 Node 全局共用同一实现 |
| `skynet.features()` | NC0.3 已实现基础能力表；后续按批次补齐 `available`/`reason` 和包能力键 |
| 插件宿主与权限入口 | `.pluginManager`/`snplugin` 尚不存在；Node 兼容面的模块白名单与 `child_process`/`fs` 授权最终挂在这里 |
| Node 对照测试设施 | 需要能拉 Node 20 跑同一组用例、逐项对比返回值的运行器，否则"完整 `fs`"无法验收 |
| 构建与打包 | 新增模块要按目录清单自动收录进字节码模块包（§16.9），不再维护逐库懒加载表；owner service 要能被 `skynet.newservice` 找到 |

### 15.6 优先级判断

三块是真正的拦路石，其余都可以在其上并行展开：

1. **模块系统**：没有 `require` 就没有 Node 代码可跑，`node_modules`、内置模块映射、
   `require('fs')` 全部悬空。当前全局脚本 loader 无法复用，必须新写。
2. **事件循环与定时器**：Node 的 `http`/`fs`/`stream` 全部假设"回调会被自动驱动"。
   SkyJS 现在是"来消息才推进 microtask"，必须补统一 tick 入口与 nextTick drain，
   否则定时器、流事件、keep-alive 都不会按时触发。
3. **owner service + 权限层 + 二进制通道**：完整 `fs`、`child_process`、流都依赖它。
   现状的 `fopen` 直通且无 errno，必须先把权限/配额/错误结构化补上，Node facade
   才有安全的落脚点。

## 16. 目标架构设计（已确认，允许重构现有库）

前提：项目处于开发初期，现有 `io.js`/`http.js`/`websocket.js` 的全局注入形态可以
推翻重来。本节给出一套面向长期演进的目标架构，而不是在旧结构上打补丁。**本次重构
不设旧 API 兼容冻结项**：现有内部接口（全局注入形态、io RPC op 串、每库 env 键等）
全部按目标架构重写，不留兼容分支。唯一保持逐字不变的是 skynet 线协议与内核命令
字符串（lua-seri 字节格式、cluster 帧、skynet 命令）——它们由零修改的 `3rd/skynet`
内核与对端原版节点决定，与本次重构无关，见
[infra/01-conventions.md](infra/01-conventions.md) §3.3。

### 16.1 设计原则

1. **一份内核、多个 facade。** HTTP 协议解析、流控、socket 管理、文件原语各自只
   实现一次，Node 面向与 SkyJS 自有面向都是它之上的薄适配层。
2. **CommonJS 是运行时自身的模块格式**，不只是用户代码的兼容特性。SkyJS 自己的
   `js/` 源码也用 `require` 组织，彻底去掉"IIFE 往 `globalThis` 挂东西 + C 侧
   维护懒加载表"的双轨机制。
3. **显式依赖，禁止隐式全局。** 除 Node 规范定义的全局（`process`/`Buffer`/
   `console`/定时器/`URL`/`AbortController`…）与一个 SkyJS 服务运行时全局外，
   其余能力一律经 `require` 获取。
4. **分层单向依赖。** 上层可依赖下层，下层不得反向依赖；跨层通信只经由 owner
   service 或 C 原语。
5. **可测试性是结构的一部分。** 纯逻辑（解析、路径、解析器、编码）与副作用
   （I/O、socket、进程）分离，前者可在 Node 下直接跑差分测试。

### 16.2 分层模型

```text
┌──────────────────────────────────────────────────────────────┐
│ L4 公开面                                                     │
│   Node 面（引擎内建）：fs|http|net|stream|child_process…      │
│   SkyJS 面：内建 8 个（fsx|subprocess|crypt|cluster|          │
│     gateserver|pluginHost|log|testing）+ @skyjs 包（webapp|   │
│     websocket|archive|config|metrics|db|media|tag，§16.4.1）  │
│   全局面：process / Buffer / console / timers / skynet        │
├──────────────────────────────────────────────────────────────┤
│ L3 能力库（js/internal/*，私有，可被多个 facade 复用）         │
│   http-core / net-core / stream-core / fs-core / errors /     │
│   event-loop / binary-frame / abort / path-posix …            │
├──────────────────────────────────────────────────────────────┤
│ L2 owner service + 本地原生桥                                 │
│   引擎：.fs / .subprocess / .pluginManager                    │
│   包内：.sqlite / .media / .tag / .config / .metrics           │
├──────────────────────────────────────────────────────────────┤
│ L1 C 原语（skynetcore.<ns>，service-src/*.c；包内 C 桥随包）    │
└──────────────────────────────────────────────────────────────┘
```

每层只依赖相邻下层。L4 的两个 facade 之间不互相调用；共享逻辑下沉到 L3。

### 16.3 核心决策：CommonJS 作为运行时模块格式

这是整套重构的地基，其余设计都建立在它上面。

**现状问题。** `snjs.c` 的 `lazy_setup_js` 用一张手写 `F` 表把一个库映射到一个
全局名，`globalThis.__load_runtime(path)` 按需 `JS_Eval`。代价是：

- 每加一个库要改 C 代码 + 路径对象 + `F` 表 + `Makefile` 的 `extern` 符号列表，四处同步。
- 库之间无法表达依赖，只能靠"先加载我"的隐式顺序。
- 所有库名都污染全局命名空间，`io`/`fs`/`stream` 必然撞名。
- 无法做真正的模块缓存、循环引用、条件导出。

**目标设计。** C 侧只保留三件事：注册 `skynetcore` 原生桥、创建 `process` 与
`skynet`、启动 CJS loader 并 require 引导脚本。其余全局对象由 `js/bootstrap.js`
装配（§3），模块解析、缓存、包装全部由 JS 侧 loader 负责：

```js
// js/loader.js 职责（与 Node 对齐）
//   Module._resolveFilename(request, parent, isMain)
//   Module._load(request, parent, isMain)
//   Module._cache: Map<realpath, Module>
//   Module.wrap: (exports, require, module, __filename, __dirname) => { ... }
```

C 侧只需提供两个能力：`skynetcore.runtime.readModuleSource(id)` 取源码/字节码，
以及一个 `__snjs_require` 入口。模块目录通过构建期生成的清单注入，不再手写符号表。

**收益。** 新增库 = 新增一个文件 + 目录清单自动收录；依赖用 `require` 表达；
命名空间冲突消失；内部实现可以自由拆分小文件。

### 16.4 目录结构

本节是目录结构的唯一定义处，`docs/infra/*` 只引用不复述。目录把**引擎层**与
**`@skyjs` 包层**分开：引擎只保留运行时底座、Node 兼容面与引擎自洽必需的承重件；
其余 `skyjs/*` 能力一律做成可独立发布的 `@skyjs/<name>` 包。

四节分工：16.4.1 定"某个入口归哪一层"的判据并给出完整归层总表，16.4.2 是引擎层
的完整目录与逐文件职责，16.4.3 是包层的统一形态与**逐包实现清单**，16.4.4 是
引擎/包边界的人工检查清单。新增能力先按 16.4.1 判归层，再照对应目录落文件，最后
过一遍 16.4.4。

#### 16.4.1 归属判据：什么留在引擎

一个 `skyjs/<name>` 入口归哪一层，只看它离开引擎是否还成立。满足任一判据即内建：

| 判据 | 内建项 | 理由 |
|---|---|---|
| 是 Node 规范模块本身 | `fs`/`stream`/`http`/…（层 1 全部） | 层 1 只能内建（§3.1）；连带的 `internal/*` 内核、owner service、C 原语一并内建 |
| 与层 1 模块共用内核或 owner 的 `skyjs/*` facade | `fsx`（配 `fs`/`.fs`）、`crypt`（配 `crypto`/`zlib`）、`subprocess`（配 `child_process`/`.subprocess`） | 引擎的层 1 模块依赖同一条 owner/内核，拆出去会让默认构建不自洽 |
| Actor 运行时契约 | `cluster`、`gateserver` | 跨节点传输是服务部署底座，与 skynet 调度强耦合 |
| 插件安全边界 | `pluginHost` | 必须与 `snplugin` loader 同版本发行，不能由用户替换 |
| 直接绑引擎原语的零依赖横切件 | `log`（`skynetcore.runtime.error`）、`testing`（引擎自验证契约） | 无原生依赖、体量极小，且被引擎测试与运维契约直接引用 |

不满足判据的一律做成 `@skyjs/<name>` 包：

| 包 | 入口 | 内容 | 原生部分 |
|---|---|---|---|
| `@skyjs/webapp` | `skyjs/webapp` | 路由/中间件/应用框架 | 无（纯 JS，站在公开 `http`/`net`/`stream` 之上） |
| `@skyjs/websocket` | `skyjs/websocket` | WS 握手与帧协议 | 无 |
| `@skyjs/archive` | `skyjs/archive` | zip/tar.gz 受限解包 | 可选（`native/src/js-archive.c` 作包内 C 桥加速，默认纯 JS） |
| `@skyjs/config` | `skyjs/config` | 分层配置 | 无（可选 `.config` owner） |
| `@skyjs/metrics` | `skyjs/metrics` | 指标 | 无（可选 `.metrics` owner） |
| `@skyjs/db` | `skyjs/db` | SQLite 客户端 + `.sqlite` owner | `js-sqlite.c` + 固定版本 SQLite |
| `@skyjs/media` | `skyjs/media` | probe/transcode/thumbnail/hls + `.media` owner | libav C 桥 + worker pool |
| `@skyjs/tag` | `skyjs/tag` | 标签读写 | TagLib C++ 桥 |

引擎内建因此恰好 8 个 `skyjs/*` 入口：`fsx`、`subprocess`、`crypt`、`cluster`、
`gateserver`、`pluginHost`、`log`、`testing`。其余 8 个名字不进内建表，loader 按
§3.1 回退 `node_modules/@skyjs/<name>`，不需要“哪些是包”的特判。

三条硬规则：

1. **包只依赖 L4 公开面。** 包内不得 `require('js/internal/*')`，不得直接调用
   `skynetcore.*`；它需要的原生能力由包自带（C 桥或 cservice，§3.2/§3.4）。这条
   规则是“引擎精简”的实际边界，否则私有面只是换个地方被调用。
2. **内建实现不依赖 `node_modules`。** 8 个内建入口只依赖层 1 模块与 `internal/*`，
   默认构建自洽（§3.1）。
3. **两种发行共用同一契约。** 同名能力无论内建还是走包，公开 API、错误语义、
   `features()` 键一致；包用 `peerDependencies` 锁定运行时版本区间，原生产物带
   ABI 号在装载时校验（§3.3、ND-25）。

新增能力的默认归处是 `@skyjs` 包；只有命中上表判据才进引擎。

16 个 `skyjs/*` 入口的归层总表（engine = `js/builtins/skyjs/` + `service/` +
`service-src/`；package = `packages/<name>/`）：

| 入口 | 归层 | 同批内建/包内落位 |
|---|---|---|
| `skyjs/fsx` | engine | `builtins/skyjs/fsx.js`、`internal/fs-core.js`、`service/fs-service.js`、`js-fs.c` |
| `skyjs/subprocess` | engine | `builtins/skyjs/subprocess.js`、`service/subprocess-service.js`、`js-subprocess.c` |
| `skyjs/crypt` | engine | `builtins/skyjs/crypt.js`、`internal/crypt-core.js`、`js-crypto.c` |
| `skyjs/cluster` | engine | `builtins/skyjs/cluster.js`（原 `js/cluster.js`） |
| `skyjs/gateserver` | engine | `builtins/skyjs/gateserver.js`（原 `js/gateserver.js`） |
| `skyjs/pluginHost` | engine | `builtins/skyjs/pluginHost.js`、`service/plugin-manager.js` |
| `skyjs/log` | engine | `builtins/skyjs/log.js`、`internal/errors.js` |
| `skyjs/testing` | engine | `builtins/skyjs/testing.js` |
| `skyjs/webapp` | package | `packages/webapp/`（仅 `lib/`，无原生） |
| `skyjs/websocket` | package | `packages/websocket/` |
| `skyjs/archive` | package | `packages/archive/`（可选 `native/src/js-archive.c`） |
| `skyjs/config` | package | `packages/config/`（可选 `service/config-service.js`） |
| `skyjs/metrics` | package | `packages/metrics/`（可选 `service/metrics-service.js`） |
| `skyjs/db` | package | `packages/db/`（`native/src/js-sqlite.c` + `service/sqlite-service.js`） |
| `skyjs/media` | package | `packages/media/`（`native/src/js-media.c` + `service/media-service.js`） |
| `skyjs/tag` | package | `packages/tag/`（`native/src/js-tag.cc`，复用 `.media` 或 `.tag`） |

引擎内建的收口标准只有一句：**删掉 `packages/` 整个目录后，引擎仍能构建、启动、
跑通层 1 模块与 8 个内建入口的自验证用例。** 任何时候这条不成立，说明有承重件被
错误地放进了包；反之，放进包里的东西都不允许成为引擎启动的必要条件。

#### 16.4.2 引擎层目录

引擎层只承认下表六个根目录。它们之外的任何路径都不属于引擎。

| 根目录 | 归层 | 是否进发行产物 | 是否可被 `require` |
|---|---|---|---|
| `js/` | L3 + L4（引擎面） | 是（源码或字节码清单） | 内建表内的名字可以，其余不可 |
| `include/` | 扩展作者头文件 | 是（随产物/包发布） | 不适用 |
| `service/` | L2 owner service | 是 | 仅 `skynet.newservice` 内部启动 |
| `service-src/` | L1 C 原语与 C 桥 | 是（编进 snjs.so） | 否 |
| `platform/` | 宿主接入（进程/嵌入 JNI/ABI） | 是 | 否 |
| `test/` + `tools/` | 仓库自测 | 否 | 否 |

仓库根下的 `packages/`、`node_modules/`、`Makefile`、`docs/`、`3rd/` 是构建与
开发设施，不属于引擎运行时结构；`3rd/` 永久零修改。

引擎层可以按下面的数字盘点，任何一个数字膨胀都要先过 §16.4.4：

| 引擎件 | 数量 | 内容 |
|---|---|---|
| 自举 JS | 2 | `js/bootstrap.js`、`js/loader.js` |
| L3 私有内核 | 16 | `js/internal/*.js`（§16.4.2 逐文件表） |
| L4 模块入口 | 19 + 8 | `js/builtins/**` 的 Node 规范模块 id 19 个（子路径分别计数：`fs`/`fs/promises`、`stream`/`stream/promises`、`http`/`https`…）+ `js/builtins/skyjs/` 恰好 8 个 |
| owner service | 3 | `.fs`、`.subprocess`、`.pluginManager` |
| C 源与共享头 | 12 | `service-src/`（§16.4.2 逐文件表），其中 `native-registry.c` 构建期生成 |
| 宿主接入 | 7 文件 | `platform/*.c|*.h`（`mobile/` 为后续新增，不计入） |
| 引擎链接的第三方库 | 2 类 | OpenSSL（可选）、zlib；其它一律随包 |

```text
skyjs/                            # 引擎仓库根（同时是 @skyjs 包的工作区宿主）
├── js/                           # 运行时 JS：随产物打包，不作为 npm 包安装
│   ├── bootstrap.js              # 运行时引导：注册内建表、装配全局、require 服务入口（loader 由 C 侧先行装载，§3）
│   ├── loader.js                 # CJS loader：解析、缓存、包装、循环引用、node_modules 解析（ND-3 基础版）
│   ├── internal/                 # L3 私有能力库，引擎私有；包不得 require
│   │   ├── event-loop.js         # 统一 tick 入口、定时器、nextTick 队列（§16.7）
│   │   ├── binary-frame.js       # frameEncode/frameDecode，跨 service 二进制通道
│   │   ├── errors.js             # Node 风格错误构造 + errno 映射表（唯一错误来源）
│   │   ├── abort.js              # AbortController/AbortSignal polyfill
│   │   ├── text-codec.js         # TextEncoder/TextDecoder polyfill（现 js/skynet.js 内联版本迁入）
│   │   ├── buffer-core.js        # Buffer/Blob/File 内核（NC0 供全局，NC1 供 require('buffer')）
│   │   ├── stream-core.js        # credit 流内核，Node stream 与 fs/net/http 共用
│   │   ├── net-core.js           # 连接生命周期、缓冲、背压信号
│   │   ├── http-core.js          # HTTP 报文解析/序列化/chunked（原 httpInternal）
│   │   ├── fs-core.js            # 文件操作组合逻辑，供 fs facade 与内建 fsx 共用
│   │   ├── subprocess-core.js    # spawn/stdio/回收组合逻辑，供 child_process 与内建 subprocess 共用
│   │   ├── crypt-core.js         # 哈希/HMAC/AES/Ed25519 共享内核（抽自 js/crypt.js）
│   │   ├── module-registry.js    # 内建模块名 → 实现（层 1 全部 + 引擎 8 个 skyjs/*）
│   │   ├── native-loader.js      # 第三方 C 桥装载：package.json#skyjs.native → skynetcore.native.* → module.native（§3.4.3）
│   │   ├── path-posix.js         # 平台路径语义
│   │   └── permission.js         # 路径边界/配额/能力授权判定（.fs/.subprocess owner 与插件宿主共用，NC2）
│   ├── builtins/               # L4 公开面：层 1 全部内建 + 引擎 8 个 skyjs/* 内建
│   │   ├── fs/                 # require('fs') / 'fs/promises'
│   │   │   ├── index.js
│   │   │   ├── promises.js
│   │   │   ├── handle.js       # FileHandle
│   │   │   ├── streams.js      # createReadStream/createWriteStream
│   │   │   ├── watcher.js      # watch/watchFile/FSWatcher/StatWatcher
│   │   │   └── constants.js
│   │   ├── stream/             # require('stream')
│   │   │   ├── index.js        # Readable/Writable/Duplex/Transform/pipeline/finished
│   │   │   └── promises.js     # require('stream/promises')
│   │   ├── events.js  path.js  util.js  url.js  querystring.js  console.js
│   │   ├── os.js               # os.tmpdir/homedir/platform… 数据源 skynetcore.runtime.info()
│   │   ├── buffer.js           # require('buffer')：包装 internal/buffer-core.js
│   │   ├── net.js  http.js  https.js  tls.js
│   │   ├── child_process.js  crypto.js  zlib.js
│   │   ├── fetch.js            # 装载件，不是模块入口；bootstrap require 后挂 globalThis.fetch
│   │   └── skyjs/              # 引擎内建入口，恰好 8 个；其余 skyjs/* 走 @skyjs 包（§16.4.1）
│   │       ├── fsx.js          # 自有流式 API；与 fs 共用 internal/fs-core + .fs owner
│   │       ├── subprocess.js   # 与 child_process 共用 .subprocess owner
│   │       ├── crypt.js        # 与 crypto/zlib 共用 internal/crypt-core
│   │       ├── cluster.js      # 原 js/cluster.js；跨节点传输底座
│   │       ├── gateserver.js   # 原 js/gateserver.js；与 cluster 同属运行时契约
│   │       ├── pluginHost.js   # 仅插件管理服务内可见；与 snplugin loader 同版本发行
│   │       ├── log.js          # 结构化日志；桥 skynetcore.runtime.error
│   │       └── testing.js      # 引擎自验证契约
│   └── types/                  # 按模块拆分的 .d.ts，取代单个 skyjs.d.ts
├── include/                    # 扩展作者头文件（随产物/包发布）
│   ├── skyjs-ext.h             # SKYJS_EXT_ABI_VERSION + SKYJS_EXT_EXPORT + 两入口声明（§3.4.3）
│   ├── quickjs.h               # 构建期从 3rd/quickjs 复制；扩展编译必须用这一份
│   └── quickjs-libc.h
├── service/                    # L2 owner services（引擎内建能力；01-conventions 约定目录）
│   ├── fs-service.js           # .fs（供 fs / fsx）：fd 独占、偏移、取消、退出回收
│   ├── subprocess-service.js   # .subprocess（供 child_process / subprocess）：句柄、stdio 读循环、kill 兜底
│   └── plugin-manager.js       # .pluginManager（供插件宿主）：插件 VM 与权限裁决
├── service-src/                # L1 C 原语与 C 桥（编进 cservice/snjs.so；STATIC=1 时并入 skyjs）
│   ├── snjs.c                  # 宿主：注册表装配、bootstrap、tick 驱动、插件 loader（snplugin）
│   ├── js-fs.c                 # 重构自 js-io.c，注入 skynetcore.fs（.fs owner 的原语侧）
│   ├── js-net.c                # 注入 skynetcore.net（socket / netpack / 线程时钟）
│   ├── js-crypto.c  js-tls.c   # skynetcore.crypt / skynetcore.tls
│   ├── js-seri.c               # skynetcore.seri（pack / unpack / str）
│   ├── js-subprocess.c         # skynetcore.subprocess
│   ├── js-runtime.c            # skynetcore.runtime.*：exit/exitCode/argv/info/hrtime/environ/readModuleSource
│   ├── js-native.c             # 第三方 C 桥装载：路径解析 + abi 校验 + dlsym("skyjs_ext_init")（§3.4.3）
│   ├── snjs-internal.h         # C 源共享声明（现有文件扩展）
│   └── skyclusterd.c           # cluster 守护进程（现有）
│                               # 静态 C 桥表来自构建期生成的 native-registry.c，随产物生成、不入库
├── platform/                   # 宿主接入层：main.c / env.c / builtin-dl.c / mingw-compat.c / lua-stub.c+lua.h+lauxlib.h + 后续 mobile/
├── test/
│   ├── node-compat/            # Node 20 差分对拍（同一用例跑 Node 与 SkyJS）
│   ├── service/                # 端到端用例，走新 require 入口
│   └── unit/                   # 纯逻辑单测，直接跑 Node
└── tools/                      # run-tests.js、构建脚本等仓库工具
```

`internal/` 与 `builtins/` 分开，是因为前者没有稳定契约、可以随意重构，后者是
公开 API、改动要过兼容评审。`builtins/skyjs/` 与 `builtins/` 根下的 Node 名字分开，
是因为前者服务 `skyjs/*` 规范入口（可自由演进），后者要贴合 Node 规范。Node 面只
从内建表解析；`skyjs/*` 内建优先、未收录时回退 `@skyjs/<name>` 包（§3.1）。内建
实现不依赖 `node_modules`，保证默认构建自洽。

引擎层目录的逐文件职责如下。每一行都是"必须存在且有明确归属"的条目；新增文件时
先在本表补一行，再写代码。

**`js/` 根：自举件（2 个）**

| 文件 | 职责 | 依赖 |
|---|---|---|
| `js/bootstrap.js` | 运行时引导：注册内建模块表、装配 §3 的全局对象、`require` 服务入口（loader 由 C 侧以非模块脚本先行装载，§3） | `internal/*` |
| `js/loader.js` | CommonJS loader：`_resolveFilename`/`_load`/缓存/包装/循环引用；层 1 与层 2 的 `node_modules`、`@skyjs/*` 回退解析（§3.1、§16.3） | `internal/module-registry`、`internal/native-loader` |

**`js/internal/`：L3 私有内核（16 个，可按实现自由拆分但不改名加层）**

| 文件 | 职责 | 引擎内使用者 |
|---|---|---|
| `event-loop.js` | 唯一 tick 入口、定时器、nextTick 队列（§16.7） | `bootstrap`、`stream`/`net`/`fs` |
| `binary-frame.js` | `frameEncode`/`frameDecode`，跨 service 二进制 envelope | `fs-core`、`net-core`、`subprocess-core` |
| `errors.js` | Node 风格错误构造 + errno 映射表（唯一错误来源） | 全部内置模块 |
| `abort.js` | `AbortController`/`AbortSignal` polyfill，与 `skynet.abortController()` 同源 | `bootstrap`、`fs`/`net`/`http` |
| `text-codec.js` | `TextEncoder`/`TextDecoder` polyfill（现 `js/skynet.js` 内联版本迁入） | `bootstrap`、`buffer`、`fs`、`http` |
| `buffer-core.js` | `Buffer`/`Blob`/`File` 内核（NC0 全局、NC1 `require('buffer')`） | `bootstrap`、`buffer.js` |
| `stream-core.js` | credit 流内核；Node stream 与 `fs`/`net`/`http`/`subprocess` 共用（§16.6） | `builtins/stream`、`fs-core`、`net-core`、`http-core` |
| `net-core.js` | 连接生命周期、缓冲、背压信号（合并旧 `js/socket.js` + `js/sockethelper.js`） | `builtins/net`、`http-core`、`skyjs/gateserver` |
| `http-core.js` | HTTP 报文解析/序列化/chunked（原 `httpInternal`） | `builtins/http`、`https`、`fetch` |
| `fs-core.js` | 文件操作组合逻辑，供 `fs` facade 与内建 `fsx` 共用 | `builtins/fs`、`skyjs/fsx` |
| `subprocess-core.js` | `spawn`/`stdio`/回收组合逻辑，供 `child_process` 与内建 `subprocess` 共用 | `builtins/child_process`、`skyjs/subprocess` |
| `crypt-core.js` | 哈希/HMAC/AES/Ed25519 共享内核（抽自 `js/crypt.js`） | `builtins/crypto`、`zlib`、`skyjs/crypt` |
| `module-registry.js` | 内建模块名 → 实现；层 1 全部 + 引擎 8 个 `skyjs/*`（唯一定义处，§3） | `loader` |
| `native-loader.js` | 第三方 C 桥装载：`package.json#skyjs.native` → `skynetcore.native.*` → `module.native`（§3.4.3） | `loader` |
| `path-posix.js` | 平台路径语义（`path` 内核，避免 `path` 自我依赖） | `builtins/path`、`loader`、`fs-core` |
| `permission.js` | 路径边界、配额记账、能力授权的纯逻辑判定；`.fs`/`.subprocess` owner 与插件宿主共用（NC2 随 `.fs` 落地） | `service/fs-service.js`、`service/subprocess-service.js` |

**`js/builtins/`：L4 公开面（层 1 全部 + 引擎 8 个 `skyjs/*`）**

| 条目 | 形态 | 说明 |
|---|---|---|
| `events.js` `path.js` `util.js` `url.js` `querystring.js` | 单文件 | NC0/NC1 纯 JS 模块 |
| `os.js` | 单文件 | `platform`/`arch`/`tmpdir`/`homedir`…；数据源 `skynetcore.runtime.info()` |
| `buffer.js` | 单文件 | `require('buffer')`，包装 `internal/buffer-core.js` |
| `console.js` | 单文件 | `require('console')`；`bootstrap` require 后挂 `globalThis.console`（NC0） |
| `net.js` `http.js` `https.js` `tls.js` | 单文件 | Node facade；共享 `internal/net-core`、`http-core` |
| `child_process.js` `crypto.js` `zlib.js` | 单文件 | 分别映射 `.subprocess` owner、`crypt-core` |
| `fetch.js` | 单文件 | 装载件，不是模块入口；`bootstrap` require 后挂 `globalThis.fetch` |
| `fs/` | 目录 | `index.js`、`promises.js`、`handle.js`、`streams.js`、`watcher.js`、`constants.js` |
| `stream/` | 目录 | `index.js`（Readable/Writable/Duplex/Transform/pipeline/finished）、`promises.js` |
| `skyjs/` | 目录 | 恰好 8 个内建入口：`fsx.js`、`subprocess.js`、`crypt.js`、`cluster.js`、`gateserver.js`、`pluginHost.js`、`log.js`、`testing.js` |

`js/types/`（与 `js/builtins/` 并列）：按模块拆分的 `.d.ts`，取代单文件
`js/skyjs.d.ts`；类型文件随产物发布，不参与模块解析。

**`include/`：扩展作者头文件**

| 文件 | 职责 |
|---|---|
| `skyjs-ext.h` | `SKYJS_EXT_ABI_VERSION` + `SKYJS_EXT_EXPORT` + 两入口声明（§3.4.3） |
| `quickjs.h` `quickjs-libc.h` | 构建期从 `3rd/quickjs` 复制；扩展编译必须用这一份，保证 ABI 一致 |

**`service/`：L2 owner service（引擎恰好 3 个）**

| 文件 | 注册名 | 独占资源 | 供谁使用 |
|---|---|---|---|
| `fs-service.js` | `.fs` | fd 独占、偏移、取消、退出回收 | `fs`、`fs/promises`、内建 `fsx` |
| `subprocess-service.js` | `.subprocess` | 进程句柄、stdio 读循环、kill 兜底、并发配额 | `child_process`、内建 `subprocess` |
| `plugin-manager.js` | `.pluginManager` | 插件 VM 与权限裁决 | 内建 `pluginHost`（仅插件宿主可见） |

**`service-src/`：L1 C 原语与 C 桥（编进 `cservice/snjs.so`；`STATIC=1` 时并入 `skyjs`）**

| 文件 | 注入的命名空间 | 说明 |
|---|---|---|
| `snjs.c` | 宿主 | 注册表装配、`bootstrap`、tick 驱动、插件 loader（`snplugin`） |
| `js-fs.c` | `skynetcore.fs` | 重构自 `js-io.c`；`.fs` owner 的原语侧 |
| `js-net.c` | `skynetcore.net` | socket / netpack / 线程时钟 |
| `js-crypto.c` | `skynetcore.crypt` | 哈希/AES/RSA/随机数；`TLS=openssl` 时含 OpenSSL 路径 |
| `js-tls.c` | `skynetcore.tls` | TLS 会话原语 |
| `js-seri.c` | `skynetcore.seri` | `pack` / `unpack` / `str`（与 lua-seri 线协议字节级兼容：对外契约，不随本次重构变更） |
| `js-subprocess.c` | `skynetcore.subprocess` | `SUBPROCESS=1` 时编入；移动端不编 |
| `js-runtime.c` | `skynetcore.runtime.*` | `exit`/`exitCode`/`argv`/`info`/`hrtime`/`environ`/`readModuleSource` |
| `js-native.c` | `skynetcore.native.*` | 第三方 C 桥装载：路径解析 + ABI 校验 + `dlsym("skyjs_ext_init")`（§3.4.3） |
| `snjs-internal.h` | — | C 源共享声明 |
| `skyclusterd.c` | — | cluster 守护进程（独立二进制） |
| `native-registry.c` | — | **构建期生成、不入库**；静态 C 桥表 |

引擎里允许链接的第三方库只有 Node 层 1 模块自身需要的系统依赖：OpenSSL（`crypto`/
`tls`/`https`，`TLS=openssl`）与 zlib（`zlib`）。**领域第三方依赖**
（SQLite、libav、TagLib 等）一律不进引擎链接行。

**`platform/`：宿主接入层**

| 文件 | 职责 |
|---|---|
| `main.c` | 宿主入口：加载配置、起 skynet、返回退出码槽位（`process.exit`/`exitCode`） |
| `env.c` | 启动 JSON 配置读取（`jsBootstrap`/`jsModuleRoot`/`extpath`/`cpath`…） |
| `builtin-dl.c` | 宿主侧动态装载与符号解析适配 |
| `mingw-compat.c` | Windows/MinGW 兼容垫片 |
| `lua-stub.c` `lua.h` `lauxlib.h` | skynet-src 零修改所需的 Lua ABI 占位 |
| `mobile/`（后续） | JNI/ObjC 嵌入入口与生命周期，见 infra 12 |

**`test/` + `tools/`：不进发行产物**

| 目录 | 职责 |
|---|---|
| `test/node-compat/` | Node 20 差分对拍（同一用例跑 Node 与 SkyJS），是"完整 `fs`"等承诺的验收依据 |
| `test/service/` | 端到端用例，走新 `require` 入口 |
| `test/unit/` | 纯逻辑单测，直接 `node --test` 运行 |
| `tools/run-tests.js` 等 | 仓库工具与构建脚本；不随产物发布 |

引擎层**不包含**：任何领域能力（`webapp`/`websocket`/`archive`/`config`/`metrics`/
`db`/`media`/`tag`）、这些能力的第三方依赖与源码、`node_modules` 运行时依赖、
`packages/` 的任何文件、业务示例（`examples/`）与 benchmark 数据。领域能力及其
第三方依赖随 `@skyjs/<name>` 包分发，不再进 `service-src/` 与内建表。

引擎层的硬约束（与 §16.4.1 收口标准配套）：

- `service-src/` 下的每个 `.c` 都必须能回答"它注入哪些 `skynetcore.*` 命名空间"，
  且这些命名空间全部落在 §16.5 的表内；表外的能力说明它应该去包里。
- `js/builtins/` 根下只能出现 Node 规范模块名；任何新的自有库一律进
  `js/builtins/skyjs/` 或 `packages/`。
- `service/`、`service-src/`、`js/internal/` 与 `js/builtins/` 的条目必须一一对应
  到 §3 能力命名总表里的引擎行；对不上就是孤儿文件，先补表再落代码。
- 引擎链接行只允许 Node 层 1 需要的系统依赖（OpenSSL、zlib）与平台系统库；任何
  领域第三方库出现即违反归层。

#### 16.4.3 `@skyjs` 包层

包放在引擎仓库的 workspace 下（`packages/<name>/`），构建期以
`node_modules/@skyjs/<name>` 的形态被引擎与业务解析（§3.1 层 2）。每个包同构：

```text
packages/<name>/                  # 发布为 @skyjs/<name>
├── package.json                  # main/exports、peerDependencies（skyjs 版本区间）、skyjs.native/abi
├── index.js                      # CJS 入口；多文件用子文件 + index.js 汇总（ND-22）
├── lib/                          # 纯 JS 实现分文件（webapp 路由、websocket 帧、media 组合逻辑…）
├── native/                       # 可选，仅含原生部分的包
│   ├── <platform>-<arch>/        # 预编译产物，键与 process.platform/arch 同源（§3.4.6）
│   │   └── lib<name>.so|.dylib|.dll|.a
│   └── src/                      # 或随包携带 C/C++ 源码，宿主构建期编译（§3.2 形态三）
├── service/                      # 可选，仅需 owner 的包（db/media/tag/config/metrics）
│   └── <cap>-service.js          # 注册名 .<cap>，由 skynet.newservice 启动
├── types/index.d.ts
└── test/
```

包层统一约定：

- `index.js` 只做汇总与导出，不放实现；实现按职责放 `lib/`，避免单文件膨胀。
- 只依赖 `index.js` 允许的公开面（层 1 模块 + 其它内建或 `skyjs/*` 入口），
  不得 `require('js/internal/*')`、不得触 `skynetcore.*`（§16.4.1 规则 1）。
- 有 owner 的包，`service/<cap>-service.js` 与 `lib/` 分离：客户端库只持 `handleId`，
  原生句柄只在 owner 内（§16.8）。
- 有原生的包，`native/src/` 与 `native/<platform>-<arch>/` 二者按发行方式择一，
  不混用；`package.json` 里给出 `skyjs.native` 与 `skyjs.abi`（§3.4.6）。
- `types/index.d.ts` 与 `test/` 必备；包自测应能在 Node 下跑纯 JS 部分。

#### 16.4.3.1 逐包实现清单

下表是 §16.4.1 包行的展开，每个包都按"公开入口 / 实现文件 / 依赖的公开面 /
原生部分 / owner / 构建开关 / 明确不做什么"逐项列清。`@skyjs` 包的实现**只允许**
出现在这些包目录与 `node_modules` 自身里，不得回流到引擎目录。

先把 8 个包的目录一次列全（每个包的首层结构相同，只有 `native/`、`service/`
是否存在不同）：

```text
packages/
├── webapp/       index.js  lib/{app,middleware,body,errors}.js  types/  test/
├── websocket/    index.js  lib/{handshake,frame,server,client}.js  types/  test/
├── archive/      index.js  lib/{zip,targz,limits}.js  native/src/js-archive.c(可选)  types/  test/
├── config/       index.js  lib/{client,schema,subscribe}.js  service/config-service.js(可选)  types/  test/
├── metrics/      index.js  lib/{client,collector,exporter}.js  service/metrics-service.js(可选)  types/  test/
├── db/           index.js  lib/{client,pool,migrate,types}.js  native/src/js-sqlite.c  service/sqlite-service.js  types/  test/
├── media/        index.js  lib/{client,probe,transcode,thumbnail,hls}.js  native/src/js-media.c  service/media-service.js  types/  test/
└── tag/          index.js  lib/{client,fields}.js  native/src/js-tag.cc  service/tag-service.js(可选，或复用 .media)  types/  test/
```

每个包的 `package.json` 统一声明：`name: "@skyjs/<name>"`、`main: "index.js"`、
`exports`（含子路径）、`peerDependencies`（skyjs 运行时版本区间）、需要原生时的
`skyjs.native` 平台表与 `skyjs.abi`、以及 `files` 白名单（只发 `index.js`/`lib`/
`native/<platform>-<arch>` 或 `native/src`/`service`/`types`，不发 `test`）。
其中 `exports` 字段仅服务 Node 侧单测与 npm 发布兼容；SkyJS loader 首版忽略它，
解析只看 `main` 与文件系统子路径（§9.2）。

**`@skyjs/webapp`（`skyjs/webapp`，纯 JS，无 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/app.js`（App/Router 生命周期、`ctx` 请求上下文）、`lib/middleware.js`（中间件注册与执行链）、`lib/body.js`（请求体读取与解析）、`lib/errors.js`（HTTP 错误映射到状态码） |
| 依赖公开面 | 只依赖 `http`/`https`/`net`/`stream`/`fs`/`path`/`skyjs/log` |
| 原生 | 无 |
| owner | 无（无独立服务；运行在调用方服务内） |
| 明确不做 | 不 require `js/internal/http-core.js`，不自带 HTTP 解析器；不承诺 Express 兼容（见 §10.1） |

**`@skyjs/websocket`（`skyjs/websocket`，纯 JS，无 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/handshake.js`（Upgrade 校验、`Sec-WebSocket-Accept`）、`lib/frame.js`（帧编解码、掩码、分片、控制帧）、`lib/server.js`（挂到 `http.Server` 升级）、`lib/client.js`（`net`/`tls` 之上的客户端） |
| 依赖公开面 | 只依赖 `http`/`net`/`tls`/`stream`/`crypto` |
| 原生 | 无 |
| owner | 无 |
| 明确不做 | 不 require `js/internal/http-core.js` 或 `net-core`；不注册全局 `WebSocket`（那是引擎在能力落地后挂的规范全局，§3） |

**`@skyjs/archive`（`skyjs/archive`，默认纯 JS，可选原生加速）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/zip.js`、`lib/targz.js`、`lib/limits.js`（解包炸弹与路径穿越防护、条目数/展开体积上限） |
| 依赖公开面 | 只依赖 `fs`/`fs/promises`/`stream`/`zlib`/`skyjs/fsx`（安全拼接用 `skyjs/fsx.safeJoin`） |
| 原生 | 可选 `native/src/js-archive.c`：C 桥加速，默认不启用，纯 JS 路径必须完整可用 |
| owner | 无（无长驻资源） |
| 构建开关 | `ARCHIVE=1` 仅启用原生加速；关掉只影响性能，不影响 API |
| 明确不做 | 不 require `js/internal/fs-core.js`，不直接触 `skynetcore.*` |

**`@skyjs/config`（`skyjs/config`，纯 JS + 可选 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/client.js`（读写配置的客户端）、`lib/schema.js`（字段声明与校验）、`lib/subscribe.js`（变更订阅） |
| 依赖公开面 | 只依赖 `fs`/`path`/`skyjs/log`，落库可选依赖 `skyjs/db` |
| 原生 | 无 |
| owner | 可选 `service/config-service.js`（`.config`）：需要集中一致性与订阅广播时启用；纯文件模式不启 |
| 明确不做 | 不内置业务配置项；不定义引擎启动配置（那是 `platform/env.c` 的职责） |

**`@skyjs/metrics`（`skyjs/metrics`，纯 JS + 可选 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/client.js`（打点接口）、`lib/collector.js`（聚合与窗口）、`lib/exporter.js`（导出到日志/文件/自定义 sink） |
| 依赖公开面 | 只依赖 `skyjs/log`，导出可选依赖 `fs` 或 `skyjs/db` |
| 原生 | 无 |
| owner | 可选 `service/metrics-service.js`（`.metrics`）：多调用方共享聚合窗口时启用 |
| 明确不做 | 不内置 Prometheus/StatsD 等具体后端；`.log-sink` 这类落盘服务由使用方提供（infra 10） |

**`@skyjs/db`（`skyjs/db`，原生 + 必需 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/client.js`（`open`/`query`/`get`/`run`/`batch`/`transaction`/`exec`/`close`）、`lib/pool.js`（连接与只读副本管理）、`lib/migrate.js`（`NNNN_name.sql` 迁移 runner）、`lib/types.js`（SQLite ↔ JS 类型映射，含 BigInt 契约） |
| 依赖公开面 | 只依赖 `stream`/`skyjs/log`（+ 自身 `module.native`） |
| 原生 | `native/src/js-sqlite.c` + 固定版本 SQLite（C 桥，仅 owner 内同步调用） |
| owner | 必需 `service/sqlite-service.js`（`.sqlite`）：每个数据库文件一个 owner，独占写连接与 stmt 回收 |
| 构建开关 | `SQLITE=1`；关掉则包装载时报能力未编入 |
| 明确不做 | 不 require `js/internal/*`，不触 `skynetcore.sqlite`（该名字已不存在，§16.5）；不做字符串拼接执行后门 |

**`@skyjs/media`（`skyjs/media`，原生 + 必需 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/client.js`（`probe`/`transcode`/`thumbnail`/`fingerprint`/`hls`）、`lib/probe.js`、`lib/transcode.js`、`lib/thumbnail.js`、`lib/hls.js`（切片与 playlist 管理） |
| 依赖公开面 | 只依赖 `stream`/`fs`/`skyjs/log`（+ 自身 `module.native`） |
| 原生 | `native/src/js-media.c`（libav 封装：libavformat/libavcodec/libavfilter/libswresample/libswscale） |
| owner | 必需 `service/media-service.js`（`.media`）：独占 libav 上下文 + 包内 worker pool（[infra/08-media-tag.md](infra/08-media-tag.md) §8.1） |
| 构建开关 | `MEDIA=libav`；GPL/nonfree 编解码走独立 `MEDIA_GPL=1` |
| 明确不做 | worker pool 是包内实现，不上浮到引擎；引擎只保证包能用公开面表达"多个隔离执行体 + 结果回传" |

**`@skyjs/tag`（`skyjs/tag`，原生 + 复用/独立 owner）**

| 项 | 内容 |
|---|---|
| 实现文件 | `lib/client.js`（`read`/`write`/`readCover`）、`lib/fields.js`（多值字段与自定义标签归一化） |
| 依赖公开面 | 只依赖 `fs`/`skyjs/log`（+ 自身 `module.native`） |
| 原生 | `native/src/js-tag.cc`（TagLib C++ 适配） |
| owner | 复用 `.media`，或独立 `service/tag-service.js`（`.tag`），构建期决定；接口对业务无差别 |
| 构建开关 | `TAG=taglib` |
| 明确不做 | 不内置任何业务专有标签键名；自定义标签透传 |

每个包的 `index.js` 只做汇总与导出，实现全部在 `lib/`；`test/` 必须能在 Node 下跑
纯 JS 部分（有原生的包对原生路径用条件跳过）。包与引擎之间只有一条接口：公开
`require` 说明符与 `features()` 能力键；其余一切（文件布局、worker 数、连接池、
内部消息格式）都是包内实现细节。

#### 16.4.3.2 包的原生接入与装机

包内的原生代码有两种接入形态，与 §3.2/§3.4 一一对应，不混用：

- 只需同步 C 函数 → **C 桥模块**：包内 `native/src/*.c` 导出
  `skyjs_ext_abi` / `skyjs_ext_init`，按 `package.json#skyjs.native` 在 `extpath`
  非空时动态装载，或构建期静态链入（§3.4.3、§3.4.6）。
- 需要长驻与 Actor 隔离 → **cservice**：包内 `native/<platform>-<arch>/<name>.so`
  由启动配置的 `cpath` 追加项命中，`service/<cap>-service.js` 作为 owner（§3.2）。

包的构建与装机：`node_modules/@skyjs/<name>` 既可被构建脚本扫进字节码模块清单
（使 `skyjs/<name>` 走包实现），也可只由宿主应用在 AAR/XCFramework 组装期消费其
静态库或 C 源码（[infra/13-build-ci.md](infra/13-build-ci.md) §13.2–13.3）。`features()` 对包提供的入口仍须给出与内建一致的
能力键，且区分“包未安装”（`ERR_MODULE_NOT_FOUND`）与“能力未编入/未加载”
（`ERR_UNSUPPORTED_PLATFORM`，§3.3）。

#### 16.4.4 引擎/包边界检查清单

落任何新文件或新能力前，按顺序过一遍；任一条答案为"是"就说明归层错了，先回到
16.4.1 改表再动代码。

1. **删掉 `packages/` 后引擎还能不能构建、启动、跑通自验证用例？** 不能，说明有
   承重件被放进了包，必须搬回引擎。
2. **这个文件是不是只被 `packages/**` 引用？** 是，说明它是领域实现，应该随包走，
   不该留在 `js/internal/` 或 `service-src/`。
3. **引擎的 `service-src/` 多了一个 `.c`？** 先回答"它注入哪些 `skynetcore.*`
   命名空间"；如果这些名字是 `.sqlite`/`.media`/`.tag`/`.archive` 一类领域能力，
   它属于包内 C 桥，不属于引擎。
4. **引擎链接行多了一个第三方库？** 只有 Node 层 1 模块的系统依赖（OpenSSL、zlib）
   允许进引擎；SQLite、libav、TagLib 等一律随包链接。
5. **`js/builtins/` 根下多了一个名字？** 必须是 Node 规范模块名；自有能力只能进
   `js/builtins/skyjs/`（且命中 16.4.1 判据）或 `packages/`。
6. **包内出现了 `require('js/internal/*')` 或 `skynetcore.*`？** 直接判错；包只能
   用 L4 公开面，需要新原语时先把它提升为公开面并过兼容评审。
7. **引擎内建实现里出现了 `require('@skyjs/*')` 或其它 `node_modules` 依赖？**
   直接判错；内建实现必须只靠层 1 模块与 `internal/*` 自洽。
8. **新增入口该不该进内建表？** 只有命中 16.4.1 五条判据之一才进；默认答案是
   "不进，做成 `@skyjs/<name>` 包"。

四个可机械核查的计数（CI 可在实现批次加上断言）：引擎 `service/` 恰好 3 个文件；
`js/builtins/skyjs/` 恰好 8 个入口；引擎 `service-src/` 不出现 `.sqlite`/`.media`/
`.tag`/`.archive` 源文件；引擎产物清单不含任何 `packages/` 路径。

### 16.5 命名规范

**C 原语**：`skynetcore` 下按能力分组，取代现在扁平混装：

| 现状 | 目标 |
|---|---|
| `skynetcore.send/command/intCommand/genId/now/error/mem/response/…` | `skynetcore.runtime.*` |
| `skynetcore.io.*` | `skynetcore.fs.*` |
| `skynetcore.socket.*` | `skynetcore.net.*` |
| `skynetcore.pack/unpack/str` | `skynetcore.seri.*` |
| `skynetcore.netpack.*` | `skynetcore.netpack.*`（保留，帧协议专用） |
| `skynetcore.crypt.*`、`skynetcore.tls.*` | 不变 |
| （新增） | `skynetcore.native.*`：第三方 C 桥装载，无公开模块入口、约定仅 loader 调用（非沙箱边界，§3.4.5） |

`.runtime` 下新增（现有原语没有等价物）：

| 新增原语 | 用途 |
|---|---|
| `skynetcore.runtime.exit(code)` | §4.1 宿主退出：记录 code + 触发 skynet 命令 `ABORT` |
| `skynetcore.runtime.exitCode(code)` | §4.5 仅写退出码槽位、不触发退出（`process.exitCode`） |
| `skynetcore.runtime.readModuleSource(id)` | §16.3 loader 取源码/字节码 |
| `skynetcore.runtime.argv()` | §4.4 `process.argv` 的启动参数来源 |
| `skynetcore.runtime.info()` | §4.5 `process` 的 `platform`/`arch`/`pid`/`ppid`/`execPath`/`uptime`/版本号 |
| `skynetcore.runtime.hrtime()` | §4.5 `process.hrtime()`/`process.hrtime.bigint()` 的单调纳秒时钟 |
| `skynetcore.runtime.environ()` | §4.2 `process.env` 的宿主 environ 快照来源 |

分组让"哪个 C 文件拥有哪些原语"一目了然，也让 facade 的依赖范围可判定。

`skynetcore.media` / `.tag` / `.sqlite` / `.archive` 不再由引擎 `service-src/` 提供：
它们随 `@skyjs/media` / `@skyjs/tag` / `@skyjs/db` / `@skyjs/archive` 包分发（§16.4.1、
§16.4.3），装载后挂在各自包的 `module.native` 上，不写进引擎的 C 原语命名表。

**owner service 注册名**：引擎内建为 `.fs`、`.subprocess`、`.pluginManager`；包内
为 `.sqlite`、`.media`、`.tag`（构建期可选）、`.config`、`.metrics`（均可选）。
点号前缀保持 skynet 惯例，是服务寻址标识。

**RPC op 串**：现有 `"read_file"` 这类 op 串随 `js/io.js`/`js/ioservice.js` 一起退出
冻结域。新 `.fs` owner 直接采用清晰枚举（`op: "stat" | "open" | "read" | …`），
不续用旧的扁平字符串表，也不保留兼容分支。

**env 配置键**：从"每库一键"改为目录级少数几个键：

```text
jsBootstrap    # 引导脚本路径，默认 ./js/bootstrap.js
jsModuleRoot   # 内置模块根，默认 ./js/builtins
jsModuleSource # 模块来源：embedded | disk（开发期用 disk）
extpath        # 第三方 C 桥动态装载开关兼兜底搜索目录，; 分隔（§3.4.3）；空则关闭动态装载
```

`extpath` 为空只关闭动态装载路径：`NATIVE_EXT=1` 仍编入 `js-native.c`，
静态登记进 `native-registry.c` 的包照常通过 `initStatic()` 命中。

新增一个内置模块不再需要动 C 代码。`jsBootstrap` 取代旧的逐库 `jsLoader`/
`jsSocket`/`jsCrypt`/…（见 infra/01 §3.2）；旧键在 NC0 后不再读取，也不保留兜底。
`cpath`（cservice 搜索路径）与 `extpath` 是两个独立配置域，分别服务 §3.2 与 §3.4。

**公开面命名**：`globalThis` 只保留 Node 规范要求的全局 + `skynet`。其余全部
`require`：

| 旧 | 新 |
|---|---|
| `globalThis.io` | `require('skyjs/fsx')`（自有）与 `require('fs')`（Node）并存 |
| `globalThis.httpd`/`httpc` | `require('skyjs/webapp')` / `require('http')` |
| `globalThis.websocket` | `require('skyjs/websocket')` |
| `globalThis.crypt` | `require('skyjs/crypt')` / `require('crypto')` |
| `globalThis.cluster`/`gateserver` | `require('skyjs/cluster')` / `require('skyjs/gateserver')` |
| `globalThis.socket`/`sockethelper` | 收进 `internal/net-core`；不对外暴露 |
| `globalThis.skynet` | 保留为全局（Actor 运行时是服务代码的基础设施） |

`globalThis.skynet` 保留为全局的理由：它是服务代码的入口契约（`skynet.start` /
`dispatch`），地位等同 Node 里"进程本身就是入口"；其余能力没有这个特殊性。

### 16.6 复用规则：一份内核、多个 facade

以 HTTP 为例，三个消费方共用一个解析内核；前两个在引擎内，`webapp` 在
`@skyjs/webapp` 包内，但都用同一份 L4 契约：

```text
internal/http-core.js          ← 唯一的报文解析/序列化实现
      ├── builtins/http.js          Node http.Server/IncomingMessage/ServerResponse
      ├── builtins/https.js         在上面套 tls
      ├── builtins/http2.js（后置） 同上
      └── @skyjs/webapp/lib/*       SkyJS 路由/中间件框架（站在公开 http/net/stream 上）
```

`internal/net-core.js` 同理，同时服务 `require('net')`、`require('http')`、
`skyjs/gateserver`（内建）与 `@skyjs/websocket`（包）。

这条规则是"是否新增库"的判据：**如果新能力只是既有内核换一层 API 形状，就做
facade，不新建内核。** facade 落在引擎还是 `@skyjs` 包，按 §16.4.1 判据决定。

### 16.7 事件循环与 tick

`internal/event-loop.js` 是唯一允许直接驱动回调的地方，对外只暴露：

```js
eventLoop.tick()                 // 排空 nextTick → 排空 microtask → 跑 immediate 队列 → 跑到期定时器
eventLoop.scheduleTimeout(fn, ms) -> handle
eventLoop.nextTick(fn)
eventLoop.setImmediate(fn)
```

C 侧 `snjs.c` 的 `worker_cb` 与定时器回调统一调用 `eventLoop.tick()`。这样"消息
驱动"与"定时器驱动"收敛到同一入口，nextTick 严格顺序（§5.3）只需在这一处保证。
定时器数据由 `skynet.timeout` 提供，`eventLoop` 负责 Node 语义（毫秒、`unref`、
`ref`、clear）。注册 immediate 或首个到期定时器时经 `skynet.timeout(0)` 自唤醒
一次，保证无外部消息时 tick 仍被驱动——NC0 出口"纯定时器程序能自行推进"的落点。

### 16.8 owner service 与二进制通道

- owner service 注册名 `.cap`，独占原生资源并在取消/退出时回收。引擎内建能力的
  owner 放引擎的 `service/`（`.fs`/`.subprocess`/`.pluginManager`）；包能力的 owner
  随包放在 `packages/<name>/service/`（`.sqlite`/`.media`/`.tag`/`.config`/`.metrics`），
  由 `skynet.newservice` 按包内相对路径启动。
- 客户端库不直接持有原生句柄，只持有 `handleId`。
- 跨 service 大块二进制走 `internal/binary-frame.js`（长度前缀头 + 二进制体，
  见 infra/02 §2.2），废弃 base64 通道。
- 每个请求带 `reqId`，取消走 `{op:"cancel", reqId}`，late response 由
  `callEx` 层丢弃（infra/02 §2.1）。

### 16.9 构建与打包

- 保持"开发期跑源码、发布期跑字节码"双模式，由 `jsModuleSource` 切换。
- 字节码由构建脚本按目录清单批量生成一个模块包，loader 按模块 id 读取；
  取代 `Makefile` 里手写的 `extern snjs_bc_*` 符号列表。
- 引擎清单只扫 `js/bootstrap.js`、`js/loader.js`、`js/internal/**`、`js/builtins/**`；
  已安装的 `node_modules/@skyjs/*` 包可选并入同一清单，使其 `skyjs/<name>` 入口走
  包实现（[infra/13-build-ci.md](infra/13-build-ci.md) §13.2）。包的原生产物按 `package.json#skyjs.native` 选平台键值参与链接。
- 纯 JS 模块（`events`/`path`/`util`/`querystring` 等）不依赖 C，可在 Node 下被
  同一套 `test/unit` 直接执行，不需要起 skynet。

### 16.10 测试组织

- `test/unit/`：纯逻辑单测，直接 `node --test` 运行，覆盖解析器、路径、编码、错误映射。
- `test/node-compat/`：同一份用例分别在 Node 20 与 SkyJS 执行，逐项对拍返回值与
  错误码；这是"完整 `fs`"等承诺的验收依据。
- `test/service/`：保留现有端到端用例，迁移到新的 `require` 入口（`io-main.js` 等
  由全局 `io.*` 改为 `require('skyjs/fsx')` / `require('fs')`）。

### 16.11 现状到目标的迁移映射

| 现状文件 | 目标去向 |
|---|---|
| `js/skynet.js` | 拆为 `js/bootstrap.js` + `internal/event-loop.js` + `builtins/console.js`（console 实现自 `js/skynet.js` 迁入）；`skynet` 全局保留 |
| `js/io.js` | 自有语义 → `builtins/skyjs/fsx.js`；改为 require 形态 |
| `js/ioservice.js` | 删除，能力并入 `service/fs-service.js` |
| `js/http.js` | 解析内核 → `internal/http-core.js`；服务端/客户端 → `builtins/http.js` |
| `js/socket.js` + `js/sockethelper.js` | 合并进 `internal/net-core.js` |
| `js/websocket.js` | `packages/websocket/`（`@skyjs/websocket`），站在公开 `http`/`net` 上，不直接用 `internal/http-core` |
| `js/crypt.js` | `internal/crypt-core.js` + `builtins/skyjs/crypt.js` + `builtins/crypto.js` |
| `js/cluster.js` / `js/gateserver.js` | `builtins/skyjs/cluster.js` / `gateserver.js` |
| （新增）`webapp`/`db`/`media`/`tag`/`archive`/`config`/`metrics` | 均落 `packages/<name>/`，发布为 `@skyjs/<name>`；原生部分随包（§16.4.1、§16.4.3） |
| `js/skyjs.d.ts` | 拆到 `js/types/*.d.ts`，按模块维护 |
| `service-src/js-io.c` | 重构为 `js-fs.c`，补 fd/errno/权限/流式原语 |
| `service-src/js-net.c` | 并入 `service-src/js-net.c`（`skynetcore.net`/`netpack` 同源维护） |
| `service-src/js-crypto.c` / `js-tls.c` / `js-seri.c` | 保留，命名空间按 §16.5 分组挂载 |
| `snjs.c` 的 `lazy_setup_js` | 删除，换成 loader 引导 + 模块清单 |
| `platform/main.c` 固定 `return 0` | 改为返回退出码槽位的值（`process.exit(code)` / `process.exitCode`） |
| `js/skynet.js` 的 `skynet.exit()` | 语义收窄为"退出当前 service"；宿主退出另给 `process.exit` |

表中 `builtins/skyjs/<name>.js` 为引擎内建的单文件形态；多文件的内建入口（如
`pluginHost` 若拆多文件）改用目录形式 `builtins/skyjs/<name>/index.js`，与 Node 面
多文件模块同约定（§3.1、§16.4.2）。引擎只内建 §16.4.1 判据命中的 8 个入口；其余
`skyjs/*` 一律落 `packages/<name>/`，经 `node_modules/@skyjs/<name>` 回退解析
（§3.1、§16.4.3）。原生部分按需求选形态——长驻/需隔离走 cservice（§3.2），只是
同步 C 函数走 C 桥模块（§3.4）。

**NC0 过渡形态。** NC0 出口要求"现有 `test/config-*.json` 全部迁移到 `require`
入口且不回归"，但此时多数目标位置还不存在。约定：终将重构或出包的现有库
（`http`/`socket`/`sockethelper`/`websocket`）在 NC0 先改为可 `require` 的 CJS
内部模块，不登记进 `js/builtins/` 内建表，测试服务用相对路径引用；
`cluster`/`gateserver`/`crypt`/`io` 直接落最终位置 `js/builtins/skyjs/`。NC4 落
`builtins/http.js` 与 `internal/net-core` 后替换 `http`/`socket` 临时件；出包批次落
`packages/websocket/` 后删除 `websocket` 临时件。任何时点 `js/builtins/skyjs/`
只含 §16.4.1 的 8 个入口，过渡件不占位。

### 16.12 落地顺序

落地顺序与 §13 的 NC 批次直接对应，不另起编号：

| 顺序 | 内容 | 对应批次 |
|---|---|---|
| 1 | **模块系统先行**：落 `js/loader.js` + `bootstrap.js` + 模块清单，把现有库逐个改成 require 形态；NC0 开发期内允许源码层面临时并存，收尾前必须收敛为单一入口，不对外发布双入口 | NC0 前置 |
| 2 | **事件循环**：落 `internal/event-loop.js`，接上 C 侧 tick 与定时器 | NC0 前置 |
| 3 | **纯 JS 模块**：`events`（NC0）与 `path`/`util`/`querystring`/`url`/`os`（NC1），基本无 C 依赖，最快见效 | NC0/NC1 |
| 4 | **二进制通道 + 错误层**：`binary-frame` + `errors`，为 `fs`/流铺路 | NC1 收尾 |
| 5 | **`stream-core` + `.fs` owner + `permission` 权限层 + `fs` facade**（完整交付，`stream` facade 同批） | NC2 |
| 6 | **`.subprocess` + `child_process`** | NC3 |
| 7 | **`internal/net-core` 合并**，再落 `http-core` 与 `builtins/http.js`；同批交付 `net`/`tls`/`https`/`fetch`/`crypto`/`zlib` | NC4 |
| 8 | **领域能力出包**：`webapp`/`websocket`/`archive`/`config`/`metrics`/`db`/`media`/`tag` 落 `packages/<name>/`，内建表只留 §16.4.1 的 8 个入口 | NC2 之后持续 |

第 1、2 步是其余所有工作的前置；在它们完成前不要并行开 `fs`/`http` 的 facade，
否则会重复造第二套模块机制。NC2 的完整 `fs` 不允许拆分后置（§8.1）。第 8 步不阻塞
NC2–NC4——包依赖的公开面（`fs`/`stream`/`net`/`http`）一旦就绪即可逐个搬出，内建表中
对应的旧条目随之删除。

## 17. 与 SkyJS 基建的关系

Node 兼容层是 §16 分层模型里的一个 facade，与 SkyJS 自有 facade 共享同一套内核：

```text
Node API  /  SkyJS 自有 API       ← L4 两套 facade
        \        /
         internal/* 能力库          ← L3 共享内核
              │
        owner services / C 原语     ← L2 / L1
```

它不修改 `3rd/`，不改变 Actor 生命周期与配额边界。协议级能力（HTTP 解析、流控、
socket 生命周期、文件原语、子进程管理）只实现一次，Node 兼容层通过 facade 复用，
不另起一套平行实现。
