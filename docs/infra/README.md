# SkyJS 通用基建文档（docs/infra）

本目录规范化 SkyJS 的 P0/P1 通用基建：统一模块名、公开入口、C 注入命名、
owner service 命名、接口签名、错误码与能力清单。**当前批次只写文档，不写实现代码，
也不迁移任何业务**（Songloft 仅作为黑盒契约来源，用于验收对拍）。

命名与公开面以 [01-conventions.md](01-conventions.md) 为唯一定义处；目标架构
见 [../node-compatibility.md](../node-compatibility.md) §16。架构处于开发初期，
本目录已按目标架构（CommonJS 模块 + 四层分层）改写，不保留旧全局库的兼容包袱。

与既有文档的关系：
- 编码规范、C/JS 边界、验收入口见 [../DEVELOPMENT.md](../DEVELOPMENT.md)。
- 遗留事项与已知限制见 [../TODO.md](../TODO.md)。
- 历史演进与问题归因见 [../HISTORY.md](../HISTORY.md)，性能基线见 [../bench.md](../bench.md)。
- Node 兼容层的分批执行计划见 [../node-compatibility-plan.md](../node-compatibility-plan.md)。
- 本目录只描述**新增/扩展的通用能力**；不重复既有库的实现细节。

## 阅读顺序

1. [00-overview.md](00-overview.md) — 范围、非目标、分层模型。
2. [01-conventions.md](01-conventions.md) — **命名总表（唯一定义处）**、错误码、能力探测、通用契约。
3. 各能力库：
   - [02-core-runtime.md](02-core-runtime.md) — `skynet` 扩展、二进制消息、`stream` 内核。
   - [03-sqlite.md](03-sqlite.md) — `@skyjs/db`（包）。
   - [04-http.md](04-http.md) — Node `http`/`https` facade（引擎）+ `@skyjs/webapp`（包）。
   - [05-fs-archive.md](05-fs-archive.md) — Node `fs` + `skyjs/fsx`（引擎）+ `@skyjs/archive`（包）。
   - [06-subprocess.md](06-subprocess.md) — `child_process` + `skyjs/subprocess`（引擎）。
   - [07-crypto.md](07-crypto.md) — `crypto` + `skyjs/crypt`（引擎）。
   - [08-media-tag.md](08-media-tag.md) — `@skyjs/media` + `@skyjs/tag`（包）。
   - [09-plugin-host.md](09-plugin-host.md) — `snplugin` loader + `skyjs/pluginHost`（引擎）。
   - [10-config-log-metrics.md](10-config-log-metrics.md) — `skyjs/log`（引擎）+ `@skyjs/config`/`@skyjs/metrics`（包）。
   - [11-testing.md](11-testing.md) — `skyjs/testing`（引擎）。
   - [12-mobile.md](12-mobile.md) — 移动端可嵌入 ABI（引擎宿主接入 + 包静态链入）。
4. 工程化：
   - [13-build-ci.md](13-build-ci.md) — 构建开关与 CI 矩阵。
   - [14-integration-release.md](14-integration-release.md) — 差分/门禁/发布。
   - [15-roadmap-estimates.md](15-roadmap-estimates.md) — 批次、依赖、估算、决策门。

## 四层结构（详见 01-conventions）

| 层 | 命名 | 职责 |
|---|---|---|
| L4 公开面 | `require('<node-module>')`、`require('skyjs/<name>')`、Node 规范全局 + `skynet` | 业务与插件可见的稳定 API |
| L3 能力内核 | 引擎 `js/internal/<name>-core.js` | 私有、可重构的共享逻辑，被多个 facade 复用；**仅引擎内建 facade 可用，包不得 require** |
| L2 owner service | 引擎 `service/<cap>-service.js`；包 `packages/<name>/service/<cap>-service.js`，注册名均 `.<cap>` | 独占持有原生资源，串行化访问，对外收发消息 |
| L1 C 注入层 | 引擎 `skynetcore.<ns>`（`service-src/js-<cap>.c`）；包内 C 桥（`packages/<name>/native/src/*`） | snjs 运行时内或包内的原生绑定（同步、非阻塞原语） |

依赖方向单向：L4 → L3 → L2 → L1。两个 L4 facade 不互相依赖，共享逻辑下沉到 L3。

**引擎层与 `@skyjs` 包层**：16 个 `skyjs/*` 入口归层已定死——引擎内建 8 个
（`fsx`/`subprocess`/`crypt`/`cluster`/`gateserver`/`pluginHost`/`log`/`testing`），
其余 8 个（`webapp`/`websocket`/`archive`/`config`/`metrics`/`db`/`media`/`tag`）
落 `packages/<name>/`，发布为 `@skyjs/<name>`。包只依赖 L4 公开面，不得
`require('js/internal/*')`、不得直接调用 `skynetcore.*`。判据、引擎目录树与包布局的
唯一定义处是 [../node-compatibility.md](../node-compatibility.md) §16.4。

## 命名总表（速查，规范定义在 01-conventions.md）

Node 面模块（名字逐字沿用 Node 20）：`fs / fs/promises / stream / stream/promises /
buffer / net / tls / http / https / child_process / crypto / zlib / events / util /
path / url / querystring / os`。

不属于模块的规范全局：`fetch`、`WebSocket`、`structuredClone` 由运行时直接挂到
`globalThis`，不提供 `require('fetch')`。

SkyJS 规范入口（`require('skyjs/<name>')`）共 16 个，按归层分两组：

- **引擎内建（8）**：`fsx / subprocess / crypt / cluster / gateserver /
  pluginHost / log / testing`，实现落 `js/builtins/skyjs/*`。
- **`@skyjs` 包（8）**：`webapp / websocket / archive / config / metrics / db /
  media / tag`，实现落 `packages/<name>/`，发布为 `@skyjs/<name>`。

16 个入口都是保留的说明符命名空间，第三方包不得占用。loader 先查内建表，未收录
时回退 `node_modules/@skyjs/<name>`；归层判据与目录落位的唯一定义处是
[../node-compatibility.md](../node-compatibility.md) §16.4（引擎逐文件 §16.4.2、
逐包实现 §16.4.3.1、边界检查 §16.4.4）。

Node 面模块名必须贴合 Node 规范，且只从内建表解析。原生能力以 **C 桥模块**接入
（`register_openssl_crypto` 那种手写 `JS_NewCFunction`，按
`package.json#skyjs.native` 在 `extpath` 非空时动态装载，或构建期静态链入），
见 node-compatibility §3.4。**C 桥不是 FFI**：不提供签名驱动的任意 `.so` 调用
（§3.5）。原生部分走两种形态：长驻且需 Actor 隔离的走 cservice ABI（包可携带
预编译 `.so`、静态库或 C/C++ 源码）；只要同步 C 函数的走 C 桥模块。用户与第三方
代码走标准 `node_modules` 查找。三层归属、原生形态与 ABI 校验见
[01-conventions.md](01-conventions.md) §3 与
[../node-compatibility.md](../node-compatibility.md) §3.1–3.4。

全局面只保留 Node 规范全局与 `skynet`。旧全局库（`io / httpd / httpc /
httpInternal / socket / sockethelper / crypt / stream`）不再保留，去向见
[01-conventions.md](01-conventions.md) §3.2 与 [../node-compatibility.md](../node-compatibility.md) §16.11。

## 交付约束

- 本批只产出本目录下 17 份 Markdown（README + 00~15）。
- 不新增或修改任何 `.c / .cc / .js / Makefile` 实现文件。
- 命名总表在 [01-conventions.md](01-conventions.md) 唯一定义，其它文档只引用，不重复定义。
- 所有库按“通用能力”设计，接口层不得出现 Songloft 业务名词（songs/playlist 等仅可作为
  黑盒验收样例出现在验收小节，不进入库接口）。
