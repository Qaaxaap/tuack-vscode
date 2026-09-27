// Tuack 扩展构建脚本（esbuild，官方推荐）
// - extension host 目标：CJS + node，external: vscode
// - webview 目标：IIFE + browser（预览面板的前端资源）
//
// 官方要求 esbuild 只擦类型、不做类型检查，因此类型检查由 `pnpm check-types` 单独负责。

const esbuild = require("esbuild");
const fs = require("node:fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
	name: "problem-matcher",
	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started");
		});
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			}
			console.log("[watch] build finished");
		});
	},
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node20",
	outfile: "dist/extension.js",
	external: ["vscode"],
	sourcemap: !production,
	minify: production,
	logLevel: "silent",
	plugins: [problemMatcherPlugin],
};

/** @type {import('esbuild').BuildOptions | undefined} */
const webviewConfig = fs.existsSync("src/webview/preview.ts")
	? {
			entryPoints: ["src/webview/preview.ts"],
			bundle: true,
			format: "iife",
			platform: "browser",
			target: "es2022",
			outfile: "dist/webview/preview.js",
			sourcemap: !production,
			minify: production,
			logLevel: "silent",
			plugins: [problemMatcherPlugin],
		}
	: undefined;

async function main() {
	const configs = [extensionConfig, webviewConfig].filter(Boolean);
	if (watch) {
		const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
		await Promise.all(contexts.map((c) => c.watch()));
		console.log("[watch] watching…");
	} else {
		await Promise.all(configs.map((c) => esbuild.build(c)));
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
