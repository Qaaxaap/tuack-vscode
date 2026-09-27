import { defineConfig } from "vitest/config";

/**
 * 单元测试配置。
 *
 * 只测不依赖 VS Code API 的纯逻辑（协议分帧、scope 转义、渲染、消毒、输出归一化…）。
 * 需要真实扩展宿主的部分走 `pnpm test`（@vscode/test-cli）。
 */
export default defineConfig({
	test: {
		include: ["src/test/unit/**/*.test.ts"],
		environment: "node",
		globals: false,
		reporters: ["default"],
	},
});
