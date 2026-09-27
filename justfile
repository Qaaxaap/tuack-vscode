# tuack-vscode

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

version := `node -p "require('./package.json').version"`

# 列出所有配方
default:
    @just --list

# 进入 nix 开发环境
shell:
    nix develop

# 进入带 rustc / typst 的开发环境
shell-full:
    nix develop .#full

# 安装依赖
install:
    pnpm install

# 类型检查
check:
    pnpm run check-types

# 单元测试
test:
    pnpm run test:unit

# 构建
build:
    pnpm run build

# 监听构建
watch:
    pnpm run watch

# 类型检查 + 单元测试 + 构建
ci: check test build

# 打包 VSIX
package: build
    mkdir -p .cache/artifacts
    pnpm exec vsce package --no-dependencies -o .cache/artifacts/tuack-vscode-{{version}}.vsix

# 用扩展开发宿主打开当前目录
dev:
    code --extensionDevelopmentPath={{justfile_directory()}}

# 真二进制的集成冒烟，需要先按 src/test/integration/README.md 设好环境变量
smoke:
    ./src/test/integration/run-smoke.sh

# 清理构建产物
clean:
    rm -rf dist
