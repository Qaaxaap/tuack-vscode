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

## 对 tuack-ng 的建议（按优先级）

这些是让 IDE 集成更完整所需的协议能力，本扩展当前只能绕行或降级：

1. **`ren/preview` 支持直接传入题面文本** —— 消除「预览前必须先保存」，才能真正做到边改边看。
2. **新增 `doc/check` RPC 方法** —— 题面检查的结果（`span` / `secondary_span` / `importance` / `info` / `note`）在 tuack-ng 内部已经是结构化的，只是目前仅以 ANSI 文本写到 stderr、且退出码恒为 0。加一个 JSON 出口即可让 IDE 显示到「问题」面板。
3. **枚举渲染模板与导出器**（如 `ren/templates`），并恢复 CLI 的 `ren --list`。
4. **把 `gen` / `dmk` / `validate` / `dump` / `doc` 纳入 RPC** —— 目前只能起子进程并解析人类可读输出。
5. **`ren/run` 支持 SVG 输出** —— Typst 原生支持逐页 SVG，在 webview 里可直接内联，省掉 PDF 预览的 worker / CSP / wasm 一类问题，而且 SVG 元素可点击，便于做源码与预览的联动。
6. **`run/judge` 可中断**，或改为异步加事件。
7. **`config/set` 使用临时文件加 rename 的原子写**，并让 `revision` 具有跨进程语义（当前是进程级，跨进程乐观并发不成立）。
8. **`ren/run` 的顶层临时目录不要 `keep()`**，或提供清理方法。
9. **把 typst 作为 Rust 库链接进 `tuack-ng-rpc`** —— 需要跨平台分发的二进制就从两个减少到一个。
10. **非 TTY 环境下自动关闭 `indicatif`**（或提供 `--no-progress`），避免进度控制序列混进日志。

## 许可证

AGPL-3.0-or-later，与 [Tuack-NG](https://github.com/tuack-ng/tuack-ng) 和 [Tuack-GUI](https://github.com/tuack-ng/Tuack-GUI) 保持一致。
