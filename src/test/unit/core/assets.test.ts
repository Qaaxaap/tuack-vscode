/**
 * assets 探测测试：顺序同上游 init.rs::assets_dirs()（工作区 assets、data_local_dir/tuack-ng、
 * /usr/share/tuack-ng），有效判据只有 langs.json；另测 XDG_DATA_HOME 注入。
 * 工作区 assets 分支与真二进制实测不符，见 .cache/research/rpc-smoke-report.md 的 D8。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import {
	assetsEnvForDir,
	assetsSearchOrder,
	buildAssetsEnv,
	dataLocalRoot,
	ensureAssetsShim,
	inspectAssets,
	probedAssetsPaths,
	resolveAssetsDir,
} from "../../../core/assets";

let root = "";

beforeAll(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tuack-assets-test-"));
});

afterAll(async () => {
	await fs.promises.rm(root, { recursive: true, force: true });
});

describe("dataLocalRoot（dirs::data_local_dir 等价实现）", () => {
	it("Linux：优先 XDG_DATA_HOME，否则 ~/.local/share", () => {
		expect(dataLocalRoot({ XDG_DATA_HOME: "/xdg", HOME: "/home/u" }, "linux")).toBe("/xdg");
		expect(dataLocalRoot({ HOME: "/home/u" }, "linux")).toBe("/home/u/.local/share");
	});

	it("Windows：LOCALAPPDATA，否则 %USERPROFILE%\\AppData\\Local", () => {
		expect(dataLocalRoot({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe("C:\\Users\\u\\AppData\\Local");
		expect(dataLocalRoot({ USERPROFILE: "C:\\Users\\u" }, "win32")).toBe("C:\\Users\\u\\AppData\\Local");
	});

	it("macOS：~/Library/Application Support", () => {
		expect(dataLocalRoot({ HOME: "/Users/u" }, "darwin")).toBe("/Users/u/Library/Application Support");
	});
});

describe("assetsSearchOrder（纯函数，Doctor 直接展示）", () => {
	it("Linux：override、工作区 assets、XDG/tuack-ng、/usr/share/tuack-ng 的顺序", () => {
		const order = assetsSearchOrder({
			overridePath: "/opt/my-assets",
			workspaceRoot: "/ws",
			env: { XDG_DATA_HOME: "/xdg", HOME: "/home/u" },
			platform: "linux",
			cwd: "/",
		});
		expect(order).toEqual([
			{ path: "/opt/my-assets", source: "setting", note: "来自设置 tuack.assetsPath" },
			{ path: "/ws/assets", source: "workspace", note: "仅 debug 构建的 tuack-ng 会读这里" },
			{ path: "/xdg/tuack-ng", source: "user" },
			{ path: "/usr/share/tuack-ng", source: "system" },
		]);
	});

	it("未设置 XDG 时用 ~/.local/share", () => {
		const order = assetsSearchOrder({ env: { HOME: "/home/u" }, platform: "linux" });
		expect(order.map((entry) => entry.path)).toEqual(["/home/u/.local/share/tuack-ng", "/usr/share/tuack-ng"]);
	});

	it("Windows：用 LOCALAPPDATA，且没有 /usr/share", () => {
		const order = assetsSearchOrder({ env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, platform: "win32" });
		expect(order.map((entry) => entry.path)).toEqual(["C:\\Users\\u\\AppData\\Local\\tuack-ng"]);
	});

	it("includeWorkspaceAssets=false 时跳过工作区目录", () => {
		const order = assetsSearchOrder({ workspaceRoot: "/ws", includeWorkspaceAssets: false, env: { HOME: "/h" }, platform: "linux" });
		expect(order.map((entry) => entry.path)).not.toContain("/ws/assets");
	});

	it("nix 的相对探测是可选项（默认关闭）", () => {
		const without = assetsSearchOrder({ exePath: "/nix/store/x/bin/tuack-ng-rpc", env: { HOME: "/h" }, platform: "linux" });
		expect(without.some((entry) => entry.source === "nix-exe")).toBe(false);
		const withNix = assetsSearchOrder({
			exePath: "/nix/store/x/bin/tuack-ng-rpc",
			includeNixExeRelative: true,
			env: { HOME: "/h" },
			platform: "linux",
		});
		expect(withNix.map((entry) => entry.path)).toContain("/nix/store/x/share/tuack-ng");
	});

	it("相对 overridePath 按 cwd 解析", () => {
		const order = assetsSearchOrder({ overridePath: "vendor/assets", cwd: "/work", env: { HOME: "/h" }, platform: "linux" });
		expect(order[0]?.path).toBe("/work/vendor/assets");
	});
});

describe("inspectAssets", () => {
	/** 用显式集合模拟文件系统：`dirs` 是存在的目录，`files` 是存在的文件（langs.json）。 */
	function statFrom(dirs: string[], files: string[] = []): {
		statDirectory: (target: string) => Promise<boolean>;
		statFile: (target: string) => Promise<boolean>;
	} {
		const dirSet = new Set(dirs.map((dir) => path.normalize(dir)));
		const fileSet = new Set(files.map((file) => path.normalize(file)));
		return {
			statDirectory: async (target: string) => dirSet.has(path.normalize(target)),
			statFile: async (target: string) => fileSet.has(path.normalize(target)),
		};
	}

	it("取第一个含 langs.json 的目录，并记录所有候选的命中情况", async () => {
		const resolution = await inspectAssets({
			workspaceRoot: "/ws",
			env: { XDG_DATA_HOME: "/xdg", HOME: "/home/u" },
			platform: "linux",
			...statFrom(["/ws/assets", "/xdg/tuack-ng"], ["/xdg/tuack-ng/langs.json"]),
		});
		expect(resolution.dir).toBe("/xdg/tuack-ng");
		expect(resolution.source).toBe("user");
		expect(resolution.candidates.map((candidate) => [candidate.path, candidate.exists, candidate.hasLangs])).toEqual([
			["/ws/assets", true, false],
			["/xdg/tuack-ng", true, true],
			["/usr/share/tuack-ng", false, false],
		]);
		expect(probedAssetsPaths(resolution)).toHaveLength(3);
	});

	it("工作区 assets 优先（debug 构建）", async () => {
		const resolution = await inspectAssets({
			workspaceRoot: "/ws",
			env: { XDG_DATA_HOME: "/xdg", HOME: "/home/u" },
			platform: "linux",
			...statFrom(["/ws/assets", "/xdg/tuack-ng"], ["/ws/assets/langs.json", "/xdg/tuack-ng/langs.json"]),
		});
		expect(resolution.dir).toBe("/ws/assets");
		expect(resolution.source).toBe("workspace");
	});

	it("目录存在但没有 langs.json 不算命中（硬阻塞）", async () => {
		const resolution = await inspectAssets({
			env: { HOME: "/home/u" },
			platform: "linux",
			...statFrom(["/home/u/.local/share/tuack-ng"]),
		});
		expect(resolution.dir).toBeNull();
		expect(resolution.source).toBeNull();
		expect(await resolveAssetsDir({ env: { HOME: "/home/u" }, platform: "linux", ...statFrom([]) })).toBeNull();
	});

	it("overridePath 有效时直接命中", async () => {
		const resolution = await inspectAssets({
			overridePath: "/opt/assets",
			workspaceRoot: "/ws",
			env: { HOME: "/home/u" },
			platform: "linux",
			...statFrom(["/opt/assets"], ["/opt/assets/langs.json"]),
		});
		expect(resolution.dir).toBe("/opt/assets");
		expect(resolution.source).toBe("setting");
		expect(resolution.overrideProblem).toBeUndefined();
	});

	it("overridePath 无效时记录 overrideProblem 并回退到其它候选（但 Doctor 必须显式告警）", async () => {
		const resolution = await inspectAssets({
			overridePath: "/opt/nope",
			workspaceRoot: "/ws",
			env: { XDG_DATA_HOME: "/xdg", HOME: "/home/u" },
			platform: "linux",
			...statFrom(["/xdg/tuack-ng"], ["/xdg/tuack-ng/langs.json"]),
		});
		expect(resolution.dir).toBe("/xdg/tuack-ng");
		expect(resolution.overrideProblem).toContain("tuack.assetsPath");
		expect(resolution.overrideProblem).toContain("/opt/nope");
	});

	it("extraDirs 参与探测", async () => {
		const resolution = await inspectAssets({
			extraDirs: ["/extra/assets"],
			env: { HOME: "/h" },
			platform: "linux",
			...statFrom(["/extra/assets"], ["/extra/assets/langs.json"]),
		});
		expect(resolution.dir).toBe("/extra/assets");
		expect(resolution.source).toBe("extra");
	});
});

describe("buildAssetsEnv（环境变量注入）", () => {
	it("Linux：目录名是 tuack-ng 时注入 XDG_DATA_HOME=父目录", () => {
		const base = { PATH: "/usr/bin", XDG_DATA_HOME: "/old" };
		const result = buildAssetsEnv("/opt/tuack-ng", base, "linux");
		expect(result.injected).toBe(true);
		expect(result.variable).toBe("XDG_DATA_HOME");
		expect(result.value).toBe("/opt");
		expect(result.env["XDG_DATA_HOME"]).toBe("/opt");
		expect(result.env["PATH"]).toBe("/usr/bin");
		// 不改写原对象
		expect(base.XDG_DATA_HOME).toBe("/old");
	});

	it("Linux：目录名不是 tuack-ng 时不注入，并说明原因", () => {
		const result = buildAssetsEnv("/opt/my-assets", { HOME: "/h" }, "linux");
		expect(result.injected).toBe(false);
		expect(result.reason).toContain("tuack-ng");
		expect(result.env["XDG_DATA_HOME"]).toBeUndefined();
	});

	it("Windows：注入 LOCALAPPDATA（按 win32 规则识别目录名）", () => {
		const result = buildAssetsEnv("C:\\data\\tuack-ng", {}, "win32");
		expect(result.injected).toBe(true);
		expect(result.variable).toBe("LOCALAPPDATA");
		expect(result.value).toBe("C:\\data");
	});

	it("Windows：目录名不符时不注入", () => {
		const result = buildAssetsEnv("C:\\data\\assets-v2", {}, "win32");
		expect(result.injected).toBe(false);
		expect(result.reason).toContain("tuack-ng");
	});

	it("macOS：没有可注入的环境变量（data_local_dir 是固定路径）", () => {
		const result = buildAssetsEnv("/opt/tuack-ng", { HOME: "/h" }, "darwin");
		expect(result.injected).toBe(false);
		expect(result.reason).toContain("macOS");
	});
});

describe("ensureAssetsShim / assetsEnvForDir（真实文件系统）", () => {
	it("目录名不符时建 tuack-ng 符号链接再注入", async () => {
		const realDir = path.join(root, "downloaded-assets-v1.2.3");
		const shimRoot = path.join(root, "xdg-shim");
		await fs.promises.mkdir(path.join(realDir, "templates"), { recursive: true });
		await fs.promises.writeFile(path.join(realDir, "langs.json"), "{}");

		const link = await ensureAssetsShim(realDir, shimRoot, "linux");
		expect(link).toBe(path.join(shimRoot, "tuack-ng"));
		expect(await fs.promises.realpath(link)).toBe(await fs.promises.realpath(realDir));

		const result = await assetsEnvForDir(realDir, { env: { HOME: "/h" }, platform: "linux", shimRoot });
		expect(result.injected).toBe(true);
		expect(result.env["XDG_DATA_HOME"]).toBe(shimRoot);
	});

	it("目录名已经是 tuack-ng 时不需要 shim", async () => {
		const properDir = path.join(root, "proper", "tuack-ng");
		await fs.promises.mkdir(properDir, { recursive: true });
		const result = await assetsEnvForDir(properDir, { env: {}, platform: "linux", shimRoot: path.join(root, "unused-shim") });
		expect(result.injected).toBe(true);
		expect(result.env["XDG_DATA_HOME"]).toBe(path.dirname(properDir));
		expect(fs.existsSync(path.join(root, "unused-shim"))).toBe(false);
	});

	it("重复建 shim 是幂等的", async () => {
		const realDir = path.join(root, "repeat-assets");
		const shimRoot = path.join(root, "repeat-shim");
		await fs.promises.mkdir(realDir, { recursive: true });
		const first = await ensureAssetsShim(realDir, shimRoot, "linux");
		const second = await ensureAssetsShim(realDir, shimRoot, "linux");
		expect(first).toBe(second);
		expect(await fs.promises.realpath(second)).toBe(await fs.promises.realpath(realDir));
	});

	it("真实目录探测：含 langs.json 的目录会被选中", async () => {
		const assetsDir = path.join(root, "real-probe");
		await fs.promises.mkdir(assetsDir, { recursive: true });
		await fs.promises.writeFile(path.join(assetsDir, "langs.json"), "{\"cpp\":{}}");
		const resolution = await inspectAssets({
			overridePath: assetsDir,
			platform: "linux",
			env: { HOME: "/h" },
		});
		expect(resolution.dir).toBe(assetsDir);
		expect(resolution.source).toBe("setting");
	});
});
