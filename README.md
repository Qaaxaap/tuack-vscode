# Tuack for VS Code

在 VS Code 里开发 OI / ACM 竞赛题目：[Tuack-NG](https://github.com/tuack-ng/tuack-ng) 的 IDE 前端。

不是把 [Tuack-GUI](https://github.com/tuack-ng/Tuack-GUI) 套壳——本扩展用 `tuack-ng-rpc`（JSON-RPC over stdio）做结构化驱动，
交互全部交给 VS Code 原生能力：编辑器、工程树、问题面板、测试资源管理器、集成终端、输出通道。

> **状态：骨架阶段。** 目前只有工程骨架、协议类型契约与命令声明，功能实现按下方路线图推进。

## 需要什么

| 依赖 | 说明 |
| --- | --- |
| `tuack-ng-rpc` | 由 tuack-ng 的 `rpc` 分支提供（`cargo build -p tuack-ng-rpc`）。**必需。** |
| `typst` | 渲染 PDF 用，`tuack-ng` 以子进程方式调用。仅在「成稿渲染」时需要。 |
| tuack-ng assets | 目录需含 `langs.json` 与 `templates/`。**缺失时 `tuack-ng-rpc` 会启动即退出。** |

二进制按以下顺序探测：`tuack.rpcPath` / `tuack.typstPath` 设置 → 工作区 `tools/` → `PATH`。
assets 按 tuack-ng 自身的查找顺序探测，可用 `tuack.assetsPath` 覆盖：

1. `<工作区>/assets`（仅 debug 构建的 tuack-ng 会看这里）
2. `<XDG_DATA_HOME|~/.local/share>/tuack-ng`（Windows 为 `%LOCALAPPDATA%\tuack-ng`）
3. `/usr/share/tuack-ng`

## 计划中的功能

- **工程树**：contest → day → problem 三级结构，点击跳转。
- **题面实时预览**：编辑 `statement.md`（Markdown + MiniJinja）时并排预览，源码与预览双向滚动同步。
- **配置编辑**：`conf.json` 补全与精确校验（schema 来自 tuack-ng 的 `config/schema`）。
- **评测**：在测试资源管理器里逐数据点查看结果，可单点重跑。
- **渲染**：调用 `ren` 出 PDF。
- **数据与工具**：`gen` / `dmk` / `validate` / `dump` / `doc check` 在集成终端里执行。

## 开发

```bash
pnpm install
pnpm run watch          # 监听构建（esbuild + tsc 类型检查）
```

然后在 VS Code 里按 `F5`（「运行扩展」）启动扩展开发宿主。

```bash
pnpm run check-types    # 类型检查（esbuild 不做类型检查，必须单独跑）
pnpm run test:unit      # 单元测试（vitest）
pnpm run vsix           # 打包成 .vsix
```

### 目录

```
src/
  extension.ts      激活与组装（只做装配，不放业务逻辑）
  core/             日志、二进制与 assets 探测、Doctor
  rpc/              协议类型契约、NDJSON 传输、单进程客户端、进程池
  model/            工程模型、配置 revision、评测结果
  features/         tree / preview / diagnostics / language / test / cli
  webview/          预览面板的前端资源（独立构建目标）
```

设计决策与调研记录放在 `.cache/`（不进版本控制）。

## 设置

见 VS Code 设置里的 `Tuack` 分组。常用的几个：

- `tuack.rpcPath` / `tuack.typstPath` / `tuack.assetsPath`：手工指定路径（`machine` 作用域，不随 Settings Sync 同步）。
- `tuack.preview.saveBeforePreview`：预览前自动保存。tuack-ng 的 `ren/preview` 只读磁盘内容，关闭此项时未保存的编辑不会出现在预览里。
- `tuack.test.watchdogMinutes`：评测看门狗，超时无输出则终止卡死的评测进程。

## 设计决策与已知限制

这些是从 tuack-ng 的 `rpc` 分支源码（协议 v0.1）核实出的硬约束，直接影响本扩展的行为：

- **评测取消只能「完成当前数据点后停止」。** `run/judge` 是同步处理器，`run/cancel` 要等它返回才会被读到；单点评测没有中断钩子。UI 会如实说明这一点，不给假的「立即停止」。
- **`run/finished` 没有成功终态**（只有 `cancelled` / `error` / `closed`），且 run 只存在于评测进程内存中。因此每个数据点的权威结果取自 `run/judge` 的响应，由扩展落盘保存。
- **评测与预览互不阻塞**：`run/judge` 会阻塞它所在进程的读循环，所以控制面（配置/预览）与评测面使用不同的 `tuack-ng-rpc` 进程。
- **渲染的临时目录由扩展负责清理**：tuack-ng 用 `TempDir::keep()` 创建产物目录且不回收。
- **实时预览只保证 Markdown 语义一致**，不保证排版与最终 PDF 一致——`ren/preview`（MiniJinja 展开）与 `ren/run`（AST → Typst）是两条不同的管线。
- 因 `ren/preview` 只读磁盘，预览前会先保存文件；这一点在上游为 `ren/preview` 增加文本入参后可以去掉。
- **`file-io` 未显式配置时按 `true` 处理**：用标准输入输出的题解会被判 RE/FE，需要在 day/contest 里显式写 `"file-io": false`。

### 用真实二进制实测发现的「文档/代码 vs 线上」不一致

单元测试用的是「真子进程 + 假 NDJSON 服务端」，能覆盖进程、分帧与事件时序，但掩盖不了「我们对协议的理解与服务端实际行为不一致」。下面这些是用上游 `rpc` 分支编译出的真二进制跑出来的（复现方式见 [src/test/integration/README.md](src/test/integration/README.md)，完整报告在 `.cache/research/rpc-smoke-report.md`）。**已在本仓库修掉的用 ✅ 标注，其余是上游待修。**

| # | 现象 | 我们的处理 |
| --- | --- | --- |
| D1 | conf.json 的真实键名是 `use-pretest` / `noi-style` / `file-io`（kebab），而 `PROTOCOL.md` 附录与线上 `config/schema` 都写 snake_case；写 snake_case 会被静默忽略，而 `config/set` 仍返回成功并递增 revision | ✅ 本仓库 schema 已改为 kebab |
| D2 | `problem/get` 的 `data[].id` / `samples[].id` 是 **number**，`run/judge` 的 `testId` 只接受 **string** | ✅ 类型已改为 number，并在注释里要求调用点 `String(id)` |
| D3 | `JudgeResult.message` 在 `RE` / `TLE` 时是 **null**，而协议文档写 string | ✅ 类型已改为 `string \| null` |
| D4 | `workspace/close` 之后 `run/get` 返回 `-32001`（会话不存在），不是 `-32006` | 待上游确认 |
| D5 | `ren/preview` 会把每行行首的**一个空格吃掉**（上游按行做 `strip_prefix(' ')`），缩进代码块与嵌套列表的缩进因此被破坏；`lineMap` 行号不受影响 | 待上游修；预览因此可能与成稿有细微差异 |
| D6 | `config/set` 对未知字段静默丢弃，revision 照增，调用方无法区分「设成功」与「被吞」 | 待上游修 |
| D7 | `ren/run` 的 `files[]` 会含目录项与重复项 | 消费时按文件过滤去重 |
| D8 | `assets` 的「`<工作区>/assets`」这一候选与实测不符：debug 构建读的是**编译期源码树**的 `assets/`，工作目录下的 `assets/langs.json` 会被忽略 | 已在 `src/core/assets.ts` 的文档中标注 |
| D9 | 服务端 schema 声明 draft-07 却使用 `$defs` / `#/$defs/...` | 待上游修 |
| D10 | `run/finished` 的 `error` 字段总是显式 `null` | 消费时不依赖它 |
| D11 | `lineMap.source` 的上界是「行数 + 1」（尾换行会多出一段空段） | 换算时按上界裁剪 |

被实测**证实**的假设同样重要：`run/started` 确实早于 `run/create` 的响应（所以早到事件缓冲是必要的）、judge 的 `run/output` 早于响应、不传 `template` 的 `ren/preview` 确实不读模板、`ren/get.tmpDir` 确实需要调用方自己删、`seq` 单调递增、以及两进程下 P1 在 P2 评测期间仍能响应 `ren/preview`。

## 对 tuack-ng 的建议

### 修 bug

1. **`ren/preview` 不要吃掉行首空格**（D5）—— 现在会破坏缩进代码块与嵌套列表的缩进，直接影响预览正确性。
2. **统一 conf.json 的键名与 `config/schema` 的键名**（D1）—— 目前 schema 与实际解析不一致，用户按 schema 写配置会被静默忽略；`config/set` 还会假报成功。顺带修 `PROTOCOL.md` 附录。
3. **`problem/get` 的 id 类型与 `run/judge` 的 `testId` 对齐**（D2），**`message` 允许 null**（D3）—— 否则每个客户端都要自己踩一遍。
4. **`config/set` 对未知字段报错而不是静默丢弃**（D6）。
5. **`ren/run` 的 `files[]` 去掉目录项与重复项**（D7）。
6. **schema 要么改成 draft-07 兼容写法，要么声明 2019-09+**（D9）。

### 补能力

7. **`ren/preview` 支持直接传入题面文本** —— 消除「预览前必须先保存」，才能真正做到边改边看。
8. **新增 `doc/check` RPC 方法** —— 题面检查的结果（`span` / `secondary_span` / `importance` / `info` / `note`）在 tuack-ng 内部已经是结构化的，只是目前仅以 ANSI 文本写到 stderr、且退出码恒为 0。加一个 JSON 出口即可让 IDE 显示到「问题」面板。
9. **枚举渲染模板与导出器**（如 `ren/templates`），并恢复 CLI 的 `ren --list`。
10. **把 `gen` / `dmk` / `validate` / `dump` / `doc` 纳入 RPC** —— 目前只能起子进程并解析人类可读输出。
11. **`run/judge` 可中断**，或改为异步加事件。
12. **`config/set` 使用临时文件加 rename 的原子写**，并让 `revision` 具有跨进程语义（当前是进程级，跨进程乐观并发不成立）。
13. **`ren/run` 的顶层临时目录不要 `keep()`**，或提供清理方法。
14. **把 typst 作为 Rust 库链接进 `tuack-ng-rpc`** —— 需要跨平台分发的二进制就从两个减少到一个。
15. **非 TTY 环境下自动关闭 `indicatif`**（或提供 `--no-progress`），避免进度控制序列混进日志。

（`ren/run` 支持 SVG 输出是个加分项：Typst 原生支持逐页 SVG，在 webview 里可直接内联，省掉 PDF 预览的 worker / CSP / wasm 一类问题，而且 SVG 元素可点击，便于做源码与预览联动。本扩展当前用 `vscode.open` 打开 PDF，装了 PDF 插件时由插件渲染，所以不急。）

## 许可证

AGPL-3.0-or-later，与 [Tuack-NG](https://github.com/tuack-ng/tuack-ng) 和 [Tuack-GUI](https://github.com/tuack-ng/Tuack-GUI) 保持一致。
