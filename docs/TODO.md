# SkyJS 遗留事项与后续计划

> 历史演进记录与问题归因档案已移至 [HISTORY.md](HISTORY.md)；验收矩阵见根目录
> [README.md](../README.md)，现行规范见 [DEVELOPMENT.md](DEVELOPMENT.md)。

> **命名口径（现状／迁移前）**：本文记的 `skynetcore.socket`/`skynetcore.command`/
> `skynetcore.mem()` 等是**当前代码**的扁平命名。目标架构按能力分组
> （`skynetcore.net`/`.runtime`/…，见 [node-compatibility.md](node-compatibility.md)
> §16.5 与 [infra/01-conventions.md](infra/01-conventions.md) §3）；重构落地时本文
> 同步改写。各条限制的**行为结论**与命名无关，仍然有效。

## 待办

1. **Linux 验证未做**：目前仅在 macOS/arm64 全链验证。Makefile 已有 Linux 分支
   （`-lrt --shared`），待实测点：epoll 路径的 socket_server.c、动态库链接参数差异。
2. **JS 服务常驻内存压缩候选**（基线 snjs ~0.25MB vs snlua ~0.054MB，已量化但
   均低优先级，详见 bench.md「解读」）：
   - 共享 runtime 多 context（-43% 内存，但破坏 per-service memlimit/SIGNAL
     隔离语义，需立项评估）；
   - minimal context 白名单（现实集 -6% 堆）；
   - socket/cluster/gateserver 库按需加载（几十 KB/服务）。
3. **seri 大表 O(n²) 契约变更评估**：quickjs 的 Map 为链表实现，1000 元素表
   unpack 为 O(n²)（`sp_t1000` 场景 0.02x）；突破需契约变更（数组型 table 解
   为 Array）或引擎 patch，另议。
4. **双侧 TCP_NODELAY 评估**：cluster 串行小包 RTT 被响应方向 Nagle 平台主导
   （两侧共有）；pipelined 残余差距（skyjs 比 lua 高 ~23%）是唯一观察到的
   实现差异，双侧 nodelay 的取舍以 cl_pipe 数据为依据另行讨论。

### TLS / HTTPS / WSS (已完成)

- OpenSSL 条件编译 (`make TLS=openssl`)：macOS + Linux 均已验证
- HTTPS client / server：已实现并通过验收
- WSS client / server：已实现并通过验收（修复了 server 端 tls_upgrade 参数缺失）
- hostname verification：已添加 `SSL_set1_host`
- 自定义 CA：`ctx_set_verify` 支持可选 cafile 参数
- Docker：Dockerfile 已添加 `libssl-dev`
- CI：macOS+TLS / Linux+TLS 矩阵已添加
- 测试证书：`test/certs/` 自签名 EC 证书（10 年有效期）

## 本轮结案

- **C netpack + per-connection binary + gate/redirect**（2026-09）：新增
  `service-src/js-net.c`，对齐原版 lua-netpack 的 2 字节大端长度帧、per-fd
  分片重组与 ring queue；socket DATA 由 C 层接管，pop/clear/服务销毁完整释放。
  socket.js 默认文本解码，`{binary:true}` 按连接交付 ArrayBuffer；新增
  `skynet.redirect`、PTYPE_CLIENT 与 `js/gateserver.js`，由 `test/config-gate.json`
  覆盖 gate→watchdog→agent 的二进制、粘包、拆包回显。

## 已知限制

- config 为扁平 JSON（platform/main.c 内置 ~100 行解析器），不支持原版的
  `$VAR` 替换与 `include`。
- 无 snlua/launcher/debug_console/harbor(master-slave)；inject 热更新、
  sharetable、snax、datacenter 等无对应物（功能边界见 DEVELOPMENT.md）。
- cluster 侧未实现 clusterproxy、cluster.snax，也未与 gateserver 复用监听。
- js-seri 不映射 TYPE_USERDATA（指针），unpack 遇到即报错（跨 VM 禁传指针，
  与原版语义一致）；int64 经 BigInt 往返，JS number 侧超过 2^53 需自觉使用
  BigInt。
- 对已连接 socket 重复 `socket.start` 会重发 `OPEN("transfer")` 事件，
  socket.js 已按状态文本过滤；直接使用底层 `skynetcore.socket` 时需自行注意
  （只有 resume/accept 后的首次 start 才是真实连接事件）。
- skynet 的 `TIMEOUT` 单位是 centisecond(10ms)，JS 侧 `skynet.sleep(ms)` 已做
  换算；直接调 `skynetcore.command("TIMEOUT", ...)` 时注意单位。
- quickjs Map 链表实现带来的大表 unpack O(n²)（见待办 3），当前契约下属
  引擎固有限制。

## 已知设计限制（审计记录 2026-09）

- **seri 主机字节序**: js-seri.c 和 lua-seri.c 均使用主机字节序存储多字节整数，不支持跨字节序异构集群。与原版 skynet 行为一致。
- **QuickJS GC 暂停**: QuickJS 的 cycle collector 在大量临时对象时可能造成 worker 线程阻塞。可通过 `skynetcore.mem()` 监控。
- **cluster session 回绕**: send_session 从 1 递增到 0x7FFFFFFF 后回绕，理论上存在碰撞窗口（概率 ~1.2e-7/次回绕）。与原版 clusterd 行为一致。

## Node 兼容层遗留（2026-09）

- **NC4.1 物理合并未完成**：`js/internal/net-helper-core.js` 与
  `js/internal/net-core.js` 目前仍是两个文件。曾尝试物理并入单文件，socket
  生命周期出现 double-close（`socket_server.c dec_sending_ref` 断言），已回退；
  合并时需一并梳理 `close()` 幂等与 `httpc` 连接池关闭路径，并跑
  socket/gate/http/ws/tls 五个场景。
