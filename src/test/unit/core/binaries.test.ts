/**
 * 二进制探测测试（四段式：设置 → 工作区 tools/ 与 <contest>/.tuack/bin/ → PATH → 明确失败）。
 *
 * 探测逻辑刻意不依赖 vscode，设置值由调用方传入，因此这里可以直接用临时目录 + 注入判定。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import {
	BinaryNotFoundError,
	RPC_BINARY_NAME,
	TYPST_BINARY_NAME,
	binaryFileNames,
	defaultIsExecutable,
	resolveBinary,
	resolveTuackRpc,
	resolveTypst,
} from "../../../core/binaries";

let root = "";

beforeAll(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tuack-bin-test-"));
});

afterAll(async () => {
	await fs.promises.rm(root, { recursive: true, force: true });
});

/** 用显式文件集合当「文件系统」：只有集合里的路径才算存在且可执行。 */
function fsPredicate(files: string[]): (candidate: string) => boolean {
	const normalized = new Set(files.map((file) => path.normalize(file)));
	return (candidate: string) => normalized.has(path.normalize(candidate));
}

describe("binaryFileNames", () => {
	it("POSIX 只用裸名", () => {
		expect(binaryFileNames("tuack-ng-rpc", "linux")).toEqual(["tuack-ng-rpc"]);
	});

	it("Windows 补 .exe/.cmd/.bat", () => {
		expect(binaryFileNames("tuack-ng-rpc", "win32")).toEqual([
			"tuack-ng-rpc",
			"tuack-ng-rpc.exe",
			"tuack-ng-rpc.cmd",
			"tuack-ng-rpc.bat",
		]);
		expect(binaryFileNames("typst.exe", "win32")).toEqual(["typst.exe"]);
	});
});

describe("defaultIsExecutable（真实文件系统）", () => {
	it("普通可执行文件为 true，非可执行文件为 false，目录为 false，缺失为 false", async () => {
		const dir = path.join(root, "exec-check");
		await fs.promises.mkdir(dir, { recursive: true });
		const execFile = path.join(dir, "tool");
		const plainFile = path.join(dir, "plain");
		await fs.promises.writeFile(execFile, "#!/bin/sh\n");
		await fs.promises.writeFile(plainFile, "x");
		await fs.promises.chmod(execFile, 0o755);
		await fs.promises.chmod(plainFile, 0o644);

		expect(await defaultIsExecutable(execFile, "linux")).toBe(true);
		expect(await defaultIsExecutable(plainFile, "linux")).toBe(false);
		expect(await defaultIsExecutable(dir, "linux")).toBe(false);
		expect(await defaultIsExecutable(path.join(dir, "nope"), "linux")).toBe(false);
	});
});

describe("resolveBinary 四段式", () => {
	it("第 1 段：设置里的绝对路径优先", async () => {
		const configured = path.join(root, "custom", "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			configuredPath: configured,
			workspaceRoot: path.join(root, "ws"),
			env: { PATH: path.join(root, "bin") },
			platform: "linux",
			isExecutable: fsPredicate([configured, path.join(root, "ws", "tools", "tuack-ng-rpc")]),
		});
		expect(result.source).toBe("setting");
		expect(result.path).toBe(configured);
	});

	it("第 1 段：相对路径按 cwd 解析", async () => {
		const cwd = path.join(root, "rel-cwd");
		const configured = path.join(cwd, "tools", "typst");
		const result = await resolveBinary({
			name: TYPST_BINARY_NAME,
			configuredPath: "tools/typst",
			cwd,
			platform: "linux",
			isExecutable: fsPredicate([configured]),
		});
		expect(result.source).toBe("setting");
		expect(result.path).toBe(configured);
	});

	it("第 1 段：设置给的是目录时，在目录里按名字找", async () => {
		const configuredDir = path.join(root, "configured-dir");
		const binary = path.join(configuredDir, "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			configuredPath: configuredDir,
			platform: "linux",
			isExecutable: fsPredicate([binary]),
		});
		expect(result.path).toBe(binary);
	});

	it("第 1 段失败 → 记录 settingProblem 并回退到工作区 tools/", async () => {
		const configured = path.join(root, "broken", "tuack-ng-rpc");
		const workspaceBinary = path.join(root, "ws2", "tools", "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			configuredPath: configured,
			workspaceRoot: path.join(root, "ws2"),
			platform: "linux",
			isExecutable: fsPredicate([workspaceBinary]),
		});
		expect(result.source).toBe("workspace-tools");
		expect(result.path).toBe(workspaceBinary);
		expect(result.settingProblem).toContain("不可用");
	});

	it("第 2 段：工作区 tools/ 优先于 <contest>/.tuack/bin/", async () => {
		const workspaceBinary = path.join(root, "ws3", "tools", "tuack-ng-rpc");
		const contestBinary = path.join(root, "contest3", ".tuack", "bin", "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			workspaceRoot: path.join(root, "ws3"),
			contestRoot: path.join(root, "contest3"),
			platform: "linux",
			env: { PATH: "" },
			isExecutable: fsPredicate([workspaceBinary, contestBinary]),
		});
		expect(result.source).toBe("workspace-tools");
		expect(result.path).toBe(workspaceBinary);
	});

	it("第 2 段：工作区没有时用 <contest>/.tuack/bin/", async () => {
		const contestBinary = path.join(root, "contest4", ".tuack", "bin", "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			workspaceRoot: path.join(root, "ws4"),
			contestRoot: path.join(root, "contest4"),
			platform: "linux",
			env: { PATH: "" },
			isExecutable: fsPredicate([contestBinary]),
		});
		expect(result.source).toBe("contest-bin");
		expect(result.path).toBe(contestBinary);
	});

	it("第 3 段：PATH（POSIX 用冒号分隔）", async () => {
		const binDir = path.join(root, "path-bin");
		const binary = path.join(binDir, "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			env: { PATH: [`/nonexistent-a`, binDir, "/nonexistent-b"].join(":") },
			platform: "linux",
			isExecutable: fsPredicate([binary]),
		});
		expect(result.source).toBe("path");
		expect(result.path).toBe(binary);
	});

	it("Windows：PATH 用分号分隔，并按 .exe 候选命中", async () => {
		const binDir = "C:\\tools\\bin";
		const binary = path.join(binDir, "tuack-ng-rpc.exe");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			env: { PATH: ["C:\\Windows", binDir].join(";") },
			platform: "win32",
			isExecutable: fsPredicate([binary]),
		});
		expect(result.source).toBe("path");
		expect(result.path).toBe(binary);
	});

	it("Windows：设置里给不带扩展名的绝对路径会补 .exe", async () => {
		const configured = "C:\\custom\\tuack-ng-rpc";
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			configuredPath: configured,
			platform: "win32",
			// 宿主是 Linux，注入的判定集合里同时给 Windows 与 POSIX 两种写法
			isExecutable: fsPredicate([`${configured}.exe`, path.join(root, configured, "tuack-ng-rpc.exe")]),
		});
		expect(result.source).toBe("setting");
		expect(result.path).toBe(`${configured}.exe`);
	});

	it("Windows：设置里给相对路径按 win32 规则解析", async () => {
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			configuredPath: "tools\\tuack-ng-rpc",
			cwd: "C:\\work",
			platform: "win32",
			isExecutable: fsPredicate(["C:\\work\\tools\\tuack-ng-rpc.exe"]),
		});
		expect(result.source).toBe("setting");
		expect(result.path).toBe("C:\\work\\tools\\tuack-ng-rpc.exe");
	});

	it("extraDirs 会参与第 2 段", async () => {
		const extra = path.join(root, "extra-dir");
		const binary = path.join(extra, "tuack-ng-rpc");
		const result = await resolveBinary({
			name: RPC_BINARY_NAME,
			extraDirs: [extra],
			platform: "linux",
			env: { PATH: "" },
			isExecutable: fsPredicate([binary]),
		});
		expect(result.source).toBe("extra");
	});

	it("第 4 段：全部失败 → BinaryNotFoundError，probed 完整、advice 可操作", async () => {
		const workspaceRoot = path.join(root, "ws5");
		const contestRoot = path.join(root, "contest5");
		const error = await resolveBinary({
			name: RPC_BINARY_NAME,
			configuredPath: path.join(root, "nope", "tuack-ng-rpc"),
			workspaceRoot,
			contestRoot,
			env: { PATH: "/usr/bin:/bin" },
			platform: "linux",
			isExecutable: () => false,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(BinaryNotFoundError);
		const notFound = error as BinaryNotFoundError;
		expect(notFound.binaryName).toBe(RPC_BINARY_NAME);
		expect(notFound.probed).toContain(path.join(workspaceRoot, "tools", "tuack-ng-rpc"));
		expect(notFound.probed).toContain(path.join(contestRoot, ".tuack", "bin", "tuack-ng-rpc"));
		expect(notFound.probed).toContain("/usr/bin/tuack-ng-rpc");
		const advice = notFound.advice.join("\n");
		expect(advice).toContain("tuack.rpcPath");
		expect(advice).toContain("tools/");
		expect(advice).toContain("PATH");
		expect(advice).toContain("不提供自动下载");
	});

	it("typst 的指引指向 tuack.typstPath", async () => {
		const error = (await resolveTypst({ env: { PATH: "" }, platform: "linux", isExecutable: () => false }).catch(
			(e: unknown) => e,
		)) as BinaryNotFoundError;
		expect(error.advice.join("\n")).toContain("tuack.typstPath");
	});

	it("resolveTuackRpc 用协议约定的二进制名", async () => {
		const found = path.join(root, "name-check", "tuack-ng-rpc");
		const result = await resolveTuackRpc({ env: { PATH: path.join(root, "name-check") }, platform: "linux", isExecutable: fsPredicate([found]) });
		expect(result.name).toBe(RPC_BINARY_NAME);
	});
});
