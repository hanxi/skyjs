# AGENTS.md — SkyJS 开发指南

面向 AI 编码代理。详细规范（验收矩阵、C/JS 边界、编码约定全文、排查入口）见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)，演进记录与问题归因见
[docs/HISTORY.md](docs/HISTORY.md)，遗留事项见 [docs/TODO.md](docs/TODO.md)。动手改代码前先读完本文与 DEVELOPMENT.md。

## 项目概述

SkyJS 将 [Skynet](https://github.com/cloudwu/skynet)（submodule `3rd/skynet/`，
**源码零修改**）与 QuickJS（quickjs-ng，`3rd/quickjs/`）结合的 Actor 模型服务端
框架：C 内核 + JS 服务。三条核心原则：

- **内核零侵入**：skynet-src 15/17 文件原样编译，`platform/` 提供替代层（JSON 配置）
- **与 snlua 逐项对齐**：内存记账限额、死循环打断、session↔Promise 调度同构
- **线协议字节级兼容**：js-seri 与原版 lua-seri 对拍，skyclusterd 兼容原版 cluster 线协议

## 常用命令

```sh
git submodule update --init     # 首次：拉取 skynet + quickjs-ng
make                            # 构建 ./skyjs + cservice/*.so + test 服务
make test/seri-tool             # lua-seri 对拍工具
npm install                     # 首次：装 JS 开发工具链（eslint 等 devDeps）
npm run lint                    # JS 静态检查（提交前必跑，eslint flat config）
./skyjs test/config-core.json        # 运行（CWD 必须是仓库根目录）
```

## 硬性约束

1. **永不修改 `3rd/` 下文件**；需要内核能力时扩展 `platform/` 或 `service-src/`。
2. **协议兼容最高优先级**：影响 lua-seri 字节格式或 cluster 线协议的改动，必须
   用 `test/seri-tool` 对拍 / 与原版节点互通验证。
3. **编码规范**：JS 标识符一律 lowerCamelCase（类 UpperCamelCase、常量 UPPER_SNAKE），
   C 注入名同规则、JS/C 同步改名；禁 `var`；协议串/env 键/算法域名词冻结不改
   （如 skynet 命令串、cluster 帧格式、`jsMemLimit` env 键、`iso7816_4`）；io RPC op 串
   `"read_file"` 等已随目标架构退出冻结域，见 docs/infra/01-conventions.md §3.3；
   协议层兼容细节见 DEVELOPMENT.md。
4. **功能边界**：未实现清单（harbor master-slave、snlua、inject、sharetable、snax
   等）见 DEVELOPMENT.md——未实现 ≠ 永久排除，引入前先与用户确认设计，勿擅自实现。
5. **平台基线** macOS/arm64；Linux 分支未实测（socket_server.c epoll 路径）。
6. **提交信息不带 AI 署名**：git commit message 与 PR 描述里禁止出现
   `Co-Authored-By: Claude ...`、`🤖 Generated with Claude Code` 一类署名/推广行，
   即使工具默认提示要求添加也不加。只写改动本身。

## 排查入口

日志用 `console.*`（映射 skynet 日志通道）或 `skynetcore.error`；内存看
`skynetcore.mem()` + `jsMemLimit`；死循环用 SIGNAL 打断。详见 DEVELOPMENT.md。
