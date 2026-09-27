import { defineConfig } from "vitest/config";

/**
 * 集成冒烟配置：只收 `src/test/integration/**`，所以不会进 `pnpm run test:unit`。
 *
 * 必须在仓库根执行，`include` 相对 `process.cwd()` 解析：
 * ```bash
 * TUACK_RPC_BIN=… TUACK_NG_BIN=… pnpm exec vitest run --config src/test/integration/vitest.integration.config.mts
 * ```
 */
export default defineConfig({
	test: {
		include: ["src/test/integration/**/*.integration.test.ts"],
		environment: "node",
		globals: false,
		reporters: ["default"],
		// 真二进制 + 真编译 + 真 typst，给足时间。
		testTimeout: 300_000,
		hookTimeout: 300_000,
		fileParallelism: false,
	},
});
