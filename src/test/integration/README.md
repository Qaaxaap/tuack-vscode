# 真实 `tuack-ng-rpc` 端到端冒烟

单测（`src/test/unit/**`）用「假 NDJSON 服务端」跑两进程 E2E，验证的是我们自己的代码；
这里补的是唯一没被覆盖的一环：对着真实的 `tuack-ng-rpc` 二进制跑一遍，确认接口形态与线上一致。
默认跳过（`describe.skipIf`），`pnpm run test:unit` 不会碰到它。

## 需要什么

| 环境变量 | 必需 | 作用 |
| --- | --- | --- |
| `TUACK_RPC_BIN` | 是 | `tuack-ng-rpc` 可执行文件绝对路径 |
| `TUACK_NG_BIN` | 二选一 | `tuack-ng` CLI 绝对路径；用它 `gen contest/day/problem` 现造工程 |
| `TUACK_FIXTURE` | 二选一 | 已存在的竞赛工程根目录（会被复制进临时目录后再改，不会动原目录） |
| `TUACK_ASSETS_DIR` | 否 | 含 `langs.json` 的 assets 目录；给了就用 `core/assets.ts` 的 shim + `XDG_DATA_HOME` 注入 |
| `TUACK_SMOKE_TEMPLATE` | 否 | `ren/run` 用的模板名，默认 `markdown`（`noi`/`ccpc`/`uoj`/`loj` 需要 assets/templates + typst） |

工程需要 `g++`（`assets/langs.json` 里 cpp 的 compiler）、`typst`（只有 `ren/run` 用非 markdown 模板时才需要）。
若 `TUACK_NG_BIN` 生成的工程里 `tests` 缺少 `std` / `stdio.cpp` / `re.cpp` / `tle.cpp`，
请检查 `assets/langs.json` 能被 CLI 找到（见下）。

## 准备二进制与 assets

```bash
# 1) 源码（务必 https，不要 ssh）
git clone --depth 1 -b rpc https://github.com/tuack-ng/tuack-ng.git /tmp/tuack-ng-rpc-src
cd /tmp/tuack-ng-rpc-src

# 2) CLI 的 build.rs 需要 vendor/testlib（submodule），否则 cargo build -p tuack-ng 会 panic
git submodule update --init --depth 1 vendor/testlib   # 或把任意 testlib.h 复制到 vendor/testlib/

# 3) 编译
cargo build -p tuack-ng-rpc -p tuack-ng

# 4) assets（启动硬依赖：没有 langs.json 会在读 stdin 前秒退，stdout 零字节）
#    debug 构建的查找顺序是：<编译期 CARGO_MANIFEST_DIR>/../../assets -> $XDG_DATA_HOME|~/.local/share/tuack-ng -> /usr/share/tuack-ng
#    如果 ~/.local/share/tuack-ng 或 /usr/share/tuack-ng 里已有完整安装，可以什么都不做。
```

> `ren/run` 的模板来自 `assets/templates/{name}.json`（`assets/templates` 是 submodule）。
> 只做 `ren/preview` 不需要它——`ren/preview` 不传 `template` 时走默认参数，不读任何模板文件。

## 跑

```bash
# 仓库根
TUACK_RPC_BIN=/tmp/tuack-ng-rpc-src/target/debug/tuack-ng-rpc \
TUACK_NG_BIN=/tmp/tuack-ng-rpc-src/target/debug/tuack-ng \
./src/test/integration/run-smoke.sh
```

或者显式指定 assets 注入：

```bash
TUACK_RPC_BIN=… TUACK_NG_BIN=… TUACK_ASSETS_DIR=/tmp/tuack-ng-rpc-src/assets ./src/test/integration/run-smoke.sh
```

## 覆盖了什么

1. `initialize`（`protocolVersion` / `serverInfo` / `capabilities`）
2. `workspace/open`（真工程给 `contest`；非工程目录 `contest: null`，之后报 `-32002`）
3. `config/get` contest/day/problem（含带空格的键 `short title` / `start time` / `time limit`）
4. `problem/list` / `problem/get`（bundle 展开；`data[].id` 实测是 number）
5. `config/schema` 三份 schema 与 `schemas/tuack-conf.schema.json` 对齐（三个开关的上游 snake_case 差异单独归一化）
6. `ren/preview`（不传 template；`lineMap` 1 起；行首空格丢失）
7. `ren/run`（事件与 `ren/get`；`tmpDir` 需调用方自己删）
8. `run/create`、逐点 `run/judge`、`run/score`（默认 file-io 语义、`run/started` 早于响应）
9. RE/TLE 的 `message` / `timeMs` 取值
10. `config/set`：`file_io`（snake）静默丢弃 vs `file-io`（kebab）生效、`-32007` revision 冲突
11. 错误码：`-32600` / `-32601` / `-32001` / `-32002` / `-32005`
12. `RpcPool` 两进程：P2 跑 `run/*` 时 P1 仍能响应 `ren/preview`，id 命名空间 + 早到事件回放

结论（含实测与代码假设不一致的清单）见 `.cache/research/rpc-smoke-report.md`。
