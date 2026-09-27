/**
 * 二进制探测：`resolveBinary()` 四段式。
 *
 * 1. 设置（`tuack.rpcPath` / `tuack.typstPath`，`machine-overridable`）；
 * 2. 工作区 `tools/` 与 `<contest>/.tuack/bin/`；
 * 3. `PATH`；
 * 4. 明确失败——**v1 不做自动下载**，只给可操作指引。
 *
 * 本模块刻意**不 import vscode**：设置值由调用方（`extension.ts` / feature 层）读出来传进来，
 * 这样探测逻辑可以在 vitest 里用临时目录直接测。传参形状见 `BinaryLookupOptions`。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { logger } from "./log";

/** tuack-ng RPC 服务端可执行文件名（协议 v0.1）。 */
export const RPC_BINARY_NAME = "tuack-ng-rpc";
/** typst 可执行文件名（`ren/run` 出 PDF 时由 tuack-ng 自己调用）。 */
export const TYPST_BINARY_NAME = "typst";

/** 探测来源。 */
export type BinarySource = "setting" | "workspace-tools" | "contest-bin" | "extra" | "path";

export interface BinaryLookupOptions {
	/** 不带扩展名的二进制名，如 `tuack-ng-rpc` / `typst`。 */
	name: string;
	/** 设置里的路径（`tuack.rpcPath` / `tuack.typstPath`），未设置传 `null`/`undefined`。 */
	configuredPath?: string | null;
	workspaceRoot?: string;
	/** 竞赛工程根（含 `conf.json` 的那一级）；`<contest>/.tuack/bin/` 会在此查找。 */
	contestRoot?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** 相对路径的解析基准，默认 `workspaceRoot`，再退到 `process.cwd()`。 */
	cwd?: string;
	/** 追加查找目录（v1 未用，留给将来的 `globalStorageUri`）。 */
	extraDirs?: readonly string[];
	/** 注入可执行判定（测试用）。 */
	isExecutable?: (filePath: string) => boolean | Promise<boolean>;
}

export interface ResolvedBinary {
	name: string;
	/** 绝对路径。 */
	path: string;
	source: BinarySource;
	/** 探测过的全部候选路径（Doctor 与错误提示用）。 */
	probed: string[];
	/** 设置里给了路径但不可用时，这里说明原因（此时已回退到后续阶段）。 */
	settingProblem?: string;
}

/** 探测失败：**所有**候选都不存在/不可执行。 */
export class BinaryNotFoundError extends Error {
	readonly binaryName: string;
	readonly probed: string[];
	readonly configuredPath: string | undefined;
	readonly advice: string[];

	constructor(name: string, probed: string[], advice: string[], configuredPath?: string) {
		super(`找不到可执行的 ${name}。已探测 ${probed.length} 个位置：${probed.slice(0, 8).join("、")}${probed.length > 8 ? " …" : ""}`);
		this.name = "BinaryNotFoundError";
		this.binaryName = name;
		this.probed = probed;
		this.configuredPath = configuredPath;
		this.advice = advice;
	}
}

/**
 * 一个二进制名在指定平台上的候选文件名（Windows 需要补扩展名）。
 * 顺序即优先级：裸名 → `.exe` → `.cmd` → `.bat`。
 */
export function binaryFileNames(name: string, platform: NodeJS.Platform = process.platform): string[] {
	if (platform !== "win32") {
		return [name];
	}
	if (/\.(exe|cmd|bat|ps1)$/i.test(name)) {
		return [name];
	}
	return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

/** 默认可执行判定：常规文件 + POSIX 下 `X_OK`；Windows 只看存在。 */
export async function defaultIsExecutable(filePath: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(filePath);
		if (!stat.isFile()) {
			return false;
		}
	} catch {
		return false;
	}
	if (platform === "win32") {
		return true;
	}
	try {
		await fs.promises.access(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
	const raw = env["PATH"] ?? env["Path"] ?? ""; // Windows 的 PATH 可能以 "Path" 出现
	const delimiter = platform === "win32" ? ";" : ":";
	return raw
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

/**
 * 平台感知的绝对路径判定。
 *
 * 不能直接用 `path.isAbsolute`：它按**宿主平台**的规则判断，而本模块的 `platform` 参数是
 * 可注入的（测试要在 Linux 上验证 Windows 行为）。
 */
export function isAbsoluteFor(platform: NodeJS.Platform, target: string): boolean {
	if (platform === "win32") {
		return /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\") || target.startsWith("//");
	}
	return target.startsWith("/");
}

function resolveFor(platform: NodeJS.Platform, cwd: string, target: string): string {
	return platform === "win32" ? path.win32.resolve(cwd, target) : path.resolve(cwd, target);
}

/**
 * 四段式探测。失败时抛 `BinaryNotFoundError`（把「明确失败 + 可操作指引」交给调用方）。
 */
export async function resolveBinary(options: BinaryLookupOptions): Promise<ResolvedBinary> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? options.workspaceRoot ?? process.cwd();
	const isExecutable =
		options.isExecutable ?? ((filePath: string) => defaultIsExecutable(filePath, platform));
	const fileNames = binaryFileNames(options.name, platform);
	const probed: string[] = [];

	const tryPaths = async (candidates: readonly string[]): Promise<string | undefined> => {
		for (const candidate of candidates) {
			probed.push(candidate);
			if (await isExecutable(candidate)) {
				return candidate;
			}
		}
		return undefined;
	};

	// ── 1. 设置 ────────────────────────────────────────────────────────────
	let settingProblem: string | undefined;
	const configured = options.configuredPath?.trim();
	if (configured && configured.length > 0) {
		const resolved = isAbsoluteFor(platform, configured) ? configured : resolveFor(platform, cwd, configured);
		// 兼容两种写法：直接给文件路径，或给一个目录（目录下再按文件名找一遍）。
		const candidates: string[] = [];
		if (platform !== "win32" || /\.(exe|cmd|bat|ps1)$/i.test(resolved)) {
			candidates.push(resolved);
		} else {
			// Windows 上设置里可能写了不带扩展名的路径：补齐候选扩展名。
			candidates.push(...binaryFileNames(resolved, platform));
		}
		candidates.push(...fileNames.map((n) => path.join(resolved, n)));
		const found = await tryPaths(candidates);
		if (found) {
			logger.info(`[bin] ${options.name} 使用设置中的路径：${found}`);
			return { name: options.name, path: found, source: "setting", probed };
		}
		settingProblem = `设置里指定的路径不可用（不是可执行文件）：${resolved}`;
		logger.warn(`[bin] ${settingProblem}；继续按工作区 / PATH 探测。`);
	}

	// ── 2. 工作区 tools/ 与 <contest>/.tuack/bin/ ──────────────────────────
	const workspaceDirs: { dir: string; source: BinarySource }[] = [];
	if (options.workspaceRoot) {
		workspaceDirs.push({ dir: path.join(options.workspaceRoot, "tools"), source: "workspace-tools" });
	}
	if (options.contestRoot) {
		workspaceDirs.push({ dir: path.join(options.contestRoot, ".tuack", "bin"), source: "contest-bin" });
	}
	for (const extra of options.extraDirs ?? []) {
		workspaceDirs.push({ dir: extra, source: "extra" });
	}
	for (const { dir, source } of workspaceDirs) {
		const found = await tryPaths(fileNames.map((n) => path.join(dir, n)));
		if (found) {
			logger.info(`[bin] ${options.name} 使用工作区路径（${source}）：${found}`);
			const result: ResolvedBinary = { name: options.name, path: found, source, probed };
			if (settingProblem) {
				result.settingProblem = settingProblem;
			}
			return result;
		}
	}

	// ── 3. PATH ────────────────────────────────────────────────────────────
	const dirs = pathDirs(env, platform);
	for (const dir of dirs) {
		const found = await tryPaths(fileNames.map((n) => path.join(dir, n)));
		if (found) {
			logger.info(`[bin] ${options.name} 使用 PATH：${found}`);
			const result: ResolvedBinary = { name: options.name, path: found, source: "path", probed };
			if (settingProblem) {
				result.settingProblem = settingProblem;
			}
			return result;
		}
	}

	// ── 4. 明确失败 ────────────────────────────────────────────────────────
	const advice: string[] = [];
	if (settingProblem) {
		advice.push(settingProblem);
	}
	const settingKey = options.name === TYPST_BINARY_NAME ? "tuack.typstPath" : "tuack.rpcPath";
	advice.push(`在设置 ${settingKey} 里指定 ${options.name} 的绝对路径。`);
	if (options.workspaceRoot) {
		advice.push(`或把 ${options.name} 放到工作区的 tools/ 目录（${path.join(options.workspaceRoot, "tools")}）。`);
	}
	if (options.contestRoot) {
		advice.push(`或放到 ${path.join(options.contestRoot, ".tuack", "bin")}/。`);
	}
	advice.push(`或确保 ${options.name} 在 PATH 中${dirs.length === 0 ? "（当前 PATH 为空）" : ""}。`);
	advice.push("v1 不提供自动下载；下载与校验计划在 v2 用 globalStorageUri 实现。");
	logger.error(`[bin] 找不到 ${options.name}；已探测 ${probed.length} 个位置。`);
	throw new BinaryNotFoundError(options.name, probed, advice, configured);
}

export type TuackRpcLookupOptions = Omit<BinaryLookupOptions, "name">;
export type TypstLookupOptions = Omit<BinaryLookupOptions, "name">;

export function resolveTuackRpc(options: TuackRpcLookupOptions = {}): Promise<ResolvedBinary> {
	return resolveBinary({ ...options, name: RPC_BINARY_NAME });
}

export function resolveTypst(options: TypstLookupOptions = {}): Promise<ResolvedBinary> {
	return resolveBinary({ ...options, name: TYPST_BINARY_NAME });
}
