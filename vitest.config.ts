import { defineConfig } from "vitest/config";

/**
 * 单元测试配置：只收 src/test/unit 下的纯逻辑（不依赖 VS Code API）。
 * 需要真实扩展宿主的走 `pnpm test`（@vscode/test-cli）。
 */
export default defineConfig({
	test: {
		include: ["src/test/unit/**/*.test.ts"],
		environment: "node",
		globals: false,
		reporters: ["default"],
	},
});
