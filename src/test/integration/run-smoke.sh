#!/usr/bin/env bash
# 真实 tuack-ng-rpc 端到端冒烟的便捷入口。
#
#   TUACK_RPC_BIN=/abs/tuack-ng-rpc \
#   TUACK_NG_BIN=/abs/tuack-ng \
#   ./src/test/integration/run-smoke.sh
#
# 说明见同目录 README.md；结论见 .cache/research/rpc-smoke-report.md。
set -euo pipefail

: "${TUACK_RPC_BIN:?必须设置 TUACK_RPC_BIN（tuack-ng-rpc 绝对路径）}"
if [[ -z "${TUACK_NG_BIN:-}" && -z "${TUACK_FIXTURE:-}" ]]; then
	echo "必须设置 TUACK_NG_BIN（用 CLI 现造工程）或 TUACK_FIXTURE（现成工程根目录）" >&2
	exit 2
fi

cd "$(dirname "$0")/../../.."
exec pnpm exec vitest run --config src/test/integration/vitest.integration.config.mts "$@"
