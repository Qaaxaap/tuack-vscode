/**
 * assets 目录探测（复刻 tuack-ng 自己的查找顺序）。
 *
 * 上游 `crates/tuack-ng/src/init.rs::assets_dirs()` 的顺序：
 * 1. `<CARGO_MANIFEST_DIR>/../../assets`（**仅 debug 构建**，即源码树根的 `assets/`）→ 对应本扩展的 `<工作区>/assets`；
 * 2. `dirs::data_local_dir()/tuack-ng`（Linux 为 `$XDG_DATA_HOME|~/.local/share`；Windows 为 `%LOCALAPPDATA%`）；
 * 3. 系统目录 `/usr/share/tuack-ng`（nix 构建下是 `<exe>/../../share/tuack-ng`）。
 *
 * 判定「有效」的唯一标准是目录里有 `langs.json`——上游是
 * `assets_dirs.iter().find_map(|d| d.join("langs.json").exists())`，然后
 * `fs::read_to_string(...).unwrap()`。**没有 langs.json = 硬阻塞**（连 `ren/preview` 都不可用），
 * 不能假装降级。
 *
 * 注入点：因为上游只认 `data_local_dir()/tuack-ng`，唯一的注入方式是把子进程的
 * `XDG_DATA_HOME`（Linux）/ `LOCALAPPDATA`（Windows）指到一个**含 `tuack-ng` 子目录**的根。
 * 若探测到的目录名不是 `tuack-ng`，用 `ensureAssetsShim()` 在外加目录里建一个
 * `tuack-ng` 符号链接，再注入那个外加目录。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "./log";

export const LANGS_FILE_NAME = "langs.json";
export const ASSETS_DIR_NAME = "tuack-ng";
/** 覆盖设置项。 */
export const ASSETS_OVERRIDE_SETTING = "tuack.assetsPath";

export type AssetsSource = "setting" | "workspace" | "user" | "nix-exe" | "system" | "extra";

export interface AssetsCandidate {
	path: string;
	source: AssetsSource;
	/** 目录是否存在。 */
	exists: boolean;
	/** 是否含 `langs.json`（唯一有效判据）。 */
	hasLangs: boolean;
	note?: string;
}

export interface AssetsProbeOptions {
	/** `tuack.assetsPath` 的原始值。 */
	overridePath?: string | null;
	workspaceRoot?: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** 是否探测 `<工作区>/assets`（上游只在 debug 构建里看）。默认 true。 */
	includeWorkspaceAssets?: boolean;
	/** 入口可执行文件路径（上游 nix feature 的相对探测基准）。 */
	exePath?: string;
	/** 是否加入 `<exe>/../../share/tuack-ng`（默认 false，只在 nix 构建下有意义）。 */
	includeNixExeRelative?: boolean;
	extraDirs?: readonly string[];
	/** 注入「是否存在目录」判定（测试用）。 */
	statDirectory?: (dirPath: string) => Promise<boolean>;
	/** 注入「是否存在普通文件」判定（测试用）。判定 langs.json 用。 */
	statFile?: (filePath: string) => Promise<boolean>;
	/** 覆盖路径相对谁解析，默认 `process.cwd()`。 */
	cwd?: string;
}

export interface AssetsResolution {
	/** 第一个含 `langs.json` 的目录；`null` 表示硬阻塞。 */
	dir: string | null;
	source: AssetsSource | null;
	/** 按查找顺序排列的全部候选（Doctor 要逐条标注命中/未命中）。 */
	candidates: AssetsCandidate[];
	/** 设置了 `tuack.assetsPath` 但它无效时的说明。 */
	overrideProblem?: string;
}

/** 按目标平台选 path 实现（宿主平台可能与注入的 platform 不同）。 */
function pathsFor(platform: NodeJS.Platform): path.PlatformPath {
	return platform === "win32" ? path.win32 : path.posix;
}

/** 平台感知的绝对路径判定（不能用按宿主平台判断的 `path.isAbsolute`）。 */
function isAbsoluteFor(platform: NodeJS.Platform, target: string): boolean {
	if (platform === "win32") {
		return /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\") || target.startsWith("//");
	}
	return target.startsWith("/");
}

/** `dirs::data_local_dir()` 的等价实现。 */
export function dataLocalRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
	const home = env["HOME"] || env["USERPROFILE"] || os.homedir();
	const paths = pathsFor(platform);
	switch (platform) {
		case "win32":
			return env["LOCALAPPDATA"] || paths.join(home, "AppData", "Local");
		case "darwin":
			return paths.join(home, "Library", "Application Support");
		default:
			return env["XDG_DATA_HOME"] || paths.join(home, ".local", "share");
	}
}

/**
 * 纯函数：按 tuack-ng 的顺序算出候选目录（不碰文件系统，便于单测与 Doctor 展示）。
 */
export function assetsSearchOrder(options: AssetsProbeOptions = {}): { path: string; source: AssetsSource; note?: string }[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const paths = pathsFor(platform);
	const ordered: { path: string; source: AssetsSource; note?: string }[] = [];

	const override = options.overridePath?.trim();
	if (override && override.length > 0) {
		ordered.push({
			path: isAbsoluteFor(platform, override) ? override : paths.resolve(cwd, override),
			source: "setting",
			note: `来自设置 ${ASSETS_OVERRIDE_SETTING}`,
		});
	}

	if (options.includeWorkspaceAssets !== false && options.workspaceRoot) {
		ordered.push({
			path: paths.join(options.workspaceRoot, "assets"),
			source: "workspace",
			note: "仅 debug 构建的 tuack-ng 会读这里",
		});
	}

	ordered.push({ path: paths.join(dataLocalRoot(env, platform), ASSETS_DIR_NAME), source: "user" });

	if (options.includeNixExeRelative && options.exePath && platform !== "win32") {
		ordered.push({
			path: paths.resolve(options.exePath, "..", "..", "share", ASSETS_DIR_NAME),
			source: "nix-exe",
			note: "nix feature 的相对探测",
		});
	}

	if (platform !== "win32") {
		ordered.push({ path: "/usr/share/tuack-ng", source: "system" });
	}

	for (const extra of options.extraDirs ?? []) {
		ordered.push({ path: extra, source: "extra" });
	}
	return ordered;
}

/** 探测全部候选，返回第一个含 `langs.json` 的目录。 */
export async function inspectAssets(options: AssetsProbeOptions = {}): Promise<AssetsResolution> {
	const platform = options.platform ?? process.platform;
	const paths = pathsFor(platform);
	const statDirectory = options.statDirectory ?? isDirectory;
	const statFile = options.statFile ?? isFile;
	const ordered = assetsSearchOrder(options);
	const candidates: AssetsCandidate[] = [];
	let dir: string | null = null;
	let source: AssetsSource | null = null;

	for (const entry of ordered) {
		let exists = false;
		try {
			exists = await statDirectory(entry.path);
		} catch {
			exists = false;
		}
		let hasLangs = false;
		if (exists) {
			try {
				hasLangs = await statFile(paths.join(entry.path, LANGS_FILE_NAME));
			} catch {
				hasLangs = false;
			}
		}
		const candidate: AssetsCandidate = { path: entry.path, source: entry.source, exists, hasLangs };
		if (entry.note) {
			candidate.note = entry.note;
		}
		candidates.push(candidate);
		if (!dir && hasLangs) {
			dir = entry.path;
			source = entry.source;
		}
	}

	const resolution: AssetsResolution = { dir, source, candidates };

	const override = options.overridePath?.trim();
	if (override && override.length > 0) {
		const overrideCandidate = candidates.find((c) => c.source === "setting");
		if (overrideCandidate && !overrideCandidate.hasLangs) {
			resolution.overrideProblem =
				`${ASSETS_OVERRIDE_SETTING} 指向的目录里没有 ${LANGS_FILE_NAME}（或目录不存在）：${overrideCandidate.path}`;
			logger.warn(`[assets] ${resolution.overrideProblem}`);
		}
	}

	if (!dir) {
		logger.error(
			`[assets] 未找到含 ${LANGS_FILE_NAME} 的 assets 目录；已探测：${candidates.map((c) => c.path).join("、")}。` +
				"tuack-ng-rpc 会在启动时直接退出（硬阻塞，不可降级）。",
		);
	} else {
		logger.info(`[assets] 使用 ${dir}（来源 ${source}）。`);
	}
	return resolution;
}

/** 只要目录路径。 */
export async function resolveAssetsDir(options: AssetsProbeOptions = {}): Promise<string | null> {
	return (await inspectAssets(options)).dir;
}

/** 探测到的候选目录列表（喂给 `process.ts` 的秒退诊断 / Doctor）。 */
export function probedAssetsPaths(resolution: AssetsResolution): string[] {
	return resolution.candidates.map((candidate) => candidate.path);
}

export interface AssetsEnvResult {
	env: NodeJS.ProcessEnv;
	injected: boolean;
	variable?: "XDG_DATA_HOME" | "LOCALAPPDATA";
	value?: string;
	/** 未能注入时的原因（macOS 无环境变量注入点 / 目录名不是 tuack-ng）。 */
	reason?: string;
}

/**
 * 把子进程的环境指向指定 assets 目录。
 *
 * 前提：目录的 **basename 必须是 `tuack-ng`**（上游查的是 `data_local_dir()/tuack-ng`）。
 * 否则用 `assetsEnvForDir()`（会先建符号链接 shim）。
 */
export function buildAssetsEnv(
	dir: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): AssetsEnvResult {
	const paths = pathsFor(platform);
	const resolved = isAbsoluteFor(platform, dir) ? dir : paths.resolve(dir);
	if (paths.basename(resolved) !== ASSETS_DIR_NAME) {
		return {
			env,
			injected: false,
			reason: `assets 目录名是 ${paths.basename(resolved)}，不是 ${ASSETS_DIR_NAME}；需要先建 shim 才能通过环境变量注入。`,
		};
	}
	const parent = paths.dirname(resolved);
	if (platform === "linux") {
		return { env: { ...env, XDG_DATA_HOME: parent }, injected: true, variable: "XDG_DATA_HOME", value: parent };
	}
	if (platform === "win32") {
		return { env: { ...env, LOCALAPPDATA: parent }, injected: true, variable: "LOCALAPPDATA", value: parent };
	}
	return {
		env,
		injected: false,
		reason: "macOS 上 dirs::data_local_dir() 是 ~/Library/Application Support，没有可注入的环境变量。",
	};
}

/**
 * 在 `shimRoot` 下创建 `tuack-ng -> dir` 的符号链接（Windows 用 junction），返回链接路径。
 * 已存在且指向同一目录时直接复用。
 */
export async function ensureAssetsShim(dir: string, shimRoot: string, platform: NodeJS.Platform = process.platform): Promise<string> {
	const target = await fs.promises.realpath(path.resolve(dir));
	const link = path.join(shimRoot, ASSETS_DIR_NAME);
	await fs.promises.mkdir(shimRoot, { recursive: true });
	try {
		const existing = await fs.promises.realpath(link);
		if (existing === target) {
			return link;
		}
		await fs.promises.rm(link, { recursive: true, force: true });
	} catch {
		// 链接不存在，继续创建。
	}
	await fs.promises.symlink(target, link, platform === "win32" ? "junction" : "dir");
	logger.debug(`[assets] 已创建注入 shim：${link} -> ${target}`);
	return link;
}

export interface AssetsEnvForDirOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	/** 建 shim 的落点（通常用 `context.globalStorageUri.fsPath`）。缺省时不做 shim。 */
	shimRoot?: string;
}

/**
 * 一步到位：给出「环境变量已指向 dir」的 env。
 * 目录名不是 `tuack-ng` 且给了 `shimRoot` 时，会自动建 shim 再注入。
 */
export async function assetsEnvForDir(dir: string, options: AssetsEnvForDirOptions = {}): Promise<AssetsEnvResult> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const direct = buildAssetsEnv(dir, env, platform);
	if (direct.injected || !options.shimRoot) {
		return direct;
	}
	try {
		const link = await ensureAssetsShim(dir, options.shimRoot, platform);
		return buildAssetsEnv(link, env, platform);
	} catch (error) {
		return {
			env,
			injected: false,
			reason: `建立 assets 注入 shim 失败：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(target);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

async function isFile(target: string): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(target);
		return stat.isFile();
	} catch {
		return false;
	}
}
