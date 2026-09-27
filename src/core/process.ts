/**
 * `tuack-ng-rpc` 子进程封装。
 *
 * 这里解决四件事：
 * 1. **spawn + stderr 采集**：stderr 是有界的（默认保留尾部 64 KiB），同时可以流式回调给日志。
 * 2. **秒退识别**：`assets/langs.json` 缺失时 tuack-ng-rpc 会在读到 stdin 之前就退出
 *    （stderr 有 `Error: 找不到 langs.json`、退出码 1、stdout 零字节）。若不识别，
 *    UI 会傻等 `initialize` 超时。这里把「秒退 + stderr」直接变成可操作的诊断，
 *    并通过 `client.fail()` **立刻**拒绝在等的请求。
 * 3. **进程树 kill**：POSIX 用 `detached` + 负 pid 杀整个进程组；Windows 用 `taskkill /T /F`。
 * 4. **遗留临时目录清理**：tuack-ng 的 `tempfile::TempDir::with_prefix("tuack-ng-*")`
 *    在崩溃/被杀时会留在系统 temp 里（`tuack-ng-runner-*`、`tuack-ng-checker-*`、
 *    `tuack-ng-ren-*` 等），启动时清理掉本扩展自己留下的那批。
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RpcClient } from "../rpc/client";
import { LocalErrorCode, TuackRpcError, type QuickExitDiagnosis } from "../rpc/errors";
import { NdjsonTransport } from "../rpc/transport";
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_INITIALIZE_TIMEOUT_MS } from "../rpc/client";
import { logger } from "./log";

const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_FAST_EXIT_WINDOW_MS = 2000;
const DEFAULT_CLOSE_GRACE_MS = 1500;

/** 秒退判定与诊断所需的进程临终信息。 */
export interface RpcExitInfo {
	pid: number | undefined;
	code: number | null;
	signal: NodeJS.Signals | null;
	startedAt: number;
	elapsedMs: number;
	/** 从 stdout 读到的原始字节数；秒退时是 0。 */
	stdoutBytes: number;
	/** 成功解析出的 JSON 消息条数。 */
	messagesReceived: number;
	stderr: string;
	/** 在读到 stdin 之前就退出（缺 assets 的典型形态）。 */
	fastExit: boolean;
	diagnosis?: QuickExitDiagnosis;
	spawnError?: Error;
}

export interface SpawnRpcProcessOptions {
	command: string;
	args?: readonly string[];
	cwd?: string;
	/** 追加到 `process.env` 之上（不能删除已有变量）。 */
	env?: NodeJS.ProcessEnv;
	clientName?: string;
	clientVersion?: string;
	defaultTimeoutMs?: number;
	initializeTimeoutMs?: number;
	maxStderrBytes?: number;
	/** 秒退判定窗口（毫秒）。 */
	fastExitWindowMs?: number;
	/** stdout 已结束但子进程还活着的兜底等待（毫秒）。 */
	closeGraceMs?: number;
	/** 诊断用：已探测过的 assets 目录（会写进 advice）。 */
	probedAssetsDirs?: readonly string[];
	onStderr?: (text: string) => void;
	onExit?: (info: RpcExitInfo) => void;
}

/**
 * spawn 一个 `tuack-ng-rpc` 进程（**不**自动 initialize）。
 *
 * 典型用法：
 * ```ts
 * const proc = spawnRpcProcess({ command: rpcPath });
 * await proc.client.initialize();       // 秒退时这里会立刻抛出带诊断的错误
 * ...
 * await proc.dispose();                 // shutdown → exit → 等待 → 必要时杀进程树
 * ```
 */
export function spawnRpcProcess(options: SpawnRpcProcessOptions): RpcProcess {
	return new RpcProcess(options);
}

export class RpcProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly client: RpcClient;
	readonly transport: NdjsonTransport;

	private readonly options: SpawnRpcProcessOptions;
	private readonly maxStderrBytes: number;
	private readonly fastExitWindowMs: number;
	private readonly closeGraceMs: number;
	private readonly startedAt = Date.now();
	private readonly detached: boolean;

	private stderrBuffer = "";
	private stderrTruncated = false;
	private spawnError: Error | undefined;

	private finalized = false;
	private exitInfoValue: RpcExitInfo | undefined;
	private shutdownRequested = false;
	private killRequested = false;
	private endFallbackTimer: NodeJS.Timeout | undefined;
	private readonly exitResolvers: ((info: RpcExitInfo) => void)[] = [];

	constructor(options: SpawnRpcProcessOptions) {
		this.options = options;
		this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.fastExitWindowMs = options.fastExitWindowMs ?? DEFAULT_FAST_EXIT_WINDOW_MS;
		this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
		this.detached = process.platform !== "win32";

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(options.command, [...(options.args ?? [])], {
				cwd: options.cwd,
				env: { ...process.env, ...options.env },
				stdio: ["pipe", "pipe", "pipe"],
				detached: this.detached,
				windowsHide: true,
			});
		} catch (error) {
			// spawn 同步失败（参数非法等）——仍然返回一个「已死」的包装，避免调用方拿到 undefined。
			throw TuackRpcError.fromUnknown(LocalErrorCode.SpawnFailed, `无法启动 ${options.command}`, error);
		}
		this.child = child;

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => this.appendStderr(chunk));
		// 进程秒退时写 stdin 会 EPIPE；不吞掉这个错误会变成未处理的 'error' 事件。
		child.stdin.on("error", (error: Error) => {
			logger.debug(`[rpc] stdin 写入错误（进程可能已退出）：${error.message}`);
		});

		this.transport = new NdjsonTransport({
			input: child.stdout,
			output: child.stdin,
			onMessage: (message: Record<string, unknown>) => this.client.handleMessage(message),
			onEnd: () => this.onStreamEnd(),
		});

		this.client = new RpcClient({
			transport: this.transport,
			clientName: options.clientName,
			clientVersion: options.clientVersion,
			defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
			initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
		});

		child.on("error", (error: Error) => {
			this.spawnError = error;
			logger.error(`[rpc] 子进程错误（${options.command}）：${error.message}`);
			// pid 缺失说明是 **spawn 失败**（ENOENT/EACCES），此时不会再有真实退出码；
			// 立刻 finalize，让等待 initialize 的调用方马上拿到可操作诊断。
			if (this.child.pid === undefined) {
				this.finalize(null, null);
			}
		});
		child.on("close", (code, signal) => this.finalize(code, signal));

		logger.debug(`[rpc] 已启动 ${options.command}（pid=${child.pid ?? "?"}）`);
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get isRunning(): boolean {
		return !this.finalized;
	}

	get exitInfo(): RpcExitInfo | undefined {
		return this.exitInfoValue;
	}

	/** stderr 的**尾部**（有界）。 */
	get stderrText(): string {
		return this.stderrBuffer;
	}

	get stderrWasTruncated(): boolean {
		return this.stderrTruncated;
	}

	/** 进程结束后 resolve（含退出码与诊断）。 */
	get exited(): Promise<RpcExitInfo> {
		if (this.exitInfoValue) {
			return Promise.resolve(this.exitInfoValue);
		}
		return new Promise((resolve) => {
			this.exitResolvers.push(resolve);
		});
	}

	/**
	 * 优雅回收：`shutdown` → `exit` → 关 stdin → 等进程退出；超时则杀**进程树**。
	 * 幂等；已经退出时直接返回临终信息。
	 */
	async dispose(options?: { graceful?: boolean; timeoutMs?: number }): Promise<RpcExitInfo> {
		const graceful = options?.graceful ?? true;
		const timeoutMs = options?.timeoutMs ?? 5000;
		this.shutdownRequested = true;
		if (this.exitInfoValue) {
			return this.exitInfoValue;
		}

		if (graceful && this.client.state === "ready") {
			try {
				await this.client.shutdown({ timeoutMs: 3000 });
			} catch (error) {
				logger.debug(`[rpc] shutdown 失败（继续回收）：${describe(error)}`);
			}
		}
		if (this.client.state === "closed" || this.client.state === "ready") {
			try {
				await this.client.rawCall("exit", undefined, { timeoutMs: 2000 });
			} catch (error) {
				logger.trace(`[rpc] exit 未能发出（可能进程已退出）：${describe(error)}`);
			}
		}
		try {
			this.child.stdin.end();
		} catch {
			// stdin 可能已经关闭。
		}

		const closed = await waitForExit(this.child, timeoutMs);
		if (!closed) {
			logger.warn(`[rpc] ${this.options.command} 未在 ${timeoutMs}ms 内退出，杀进程树。`);
			await this.kill();
		}
		return this.exited;
	}

	/** 直接杀进程树（不尝试优雅退出）。 */
	async kill(options?: { timeoutMs?: number }): Promise<void> {
		this.killRequested = true;
		const pid = this.child.pid;
		if (pid === undefined) {
			return;
		}
		await killProcessTree(pid, { detached: this.detached, timeoutMs: options?.timeoutMs ?? 2000 });
	}

	// ── 内部 ────────────────────────────────────────────────────────────────

	private appendStderr(chunk: string): void {
		this.options.onStderr?.(chunk);
		if (this.stderrTruncated) {
			return;
		}
		this.stderrBuffer += chunk;
		if (this.stderrBuffer.length > this.maxStderrBytes) {
			this.stderrBuffer = this.stderrBuffer.slice(this.stderrBuffer.length - this.maxStderrBytes);
			this.stderrTruncated = true;
		}
	}

	private onStreamEnd(): void {
		// stdout 结束通常意味着进程即将 close。若 close 迟迟不来（半死进程），
		// 不能让待决请求一直挂着——用兜底定时器把它们拒掉。
		if (this.finalized || this.endFallbackTimer) {
			return;
		}
		this.endFallbackTimer = setTimeout(() => {
			if (this.finalized) {
				return;
			}
			const error = TuackRpcError.local(
				LocalErrorCode.TransportClosed,
				`${this.options.command} 的 stdout 已结束，但进程仍未退出（半死状态）。`,
				{ pid: this.child.pid },
			);
			this.client.fail(error);
		}, this.closeGraceMs);
	}

	private finalize(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.finalized) {
			return;
		}
		this.finalized = true;
		if (this.endFallbackTimer) {
			clearTimeout(this.endFallbackTimer);
			this.endFallbackTimer = undefined;
		}

		const elapsedMs = Date.now() - this.startedAt;
		const stdoutBytes = this.transport.bytesReceived;
		const messagesReceived = this.transport.messagesReceived;
		const stderr = this.stderrBuffer;

		const fastExit =
			!this.shutdownRequested &&
			!this.killRequested &&
			signal === null &&
			code !== 0 &&
			messagesReceived === 0 &&
			stdoutBytes === 0 &&
			elapsedMs <= this.fastExitWindowMs;

		const info: RpcExitInfo = {
			pid: this.child.pid,
			code,
			signal,
			startedAt: this.startedAt,
			elapsedMs,
			stdoutBytes,
			messagesReceived,
			stderr,
			fastExit,
		};
		if (this.spawnError) {
			info.spawnError = this.spawnError;
		}
		if (fastExit || this.spawnError) {
			info.diagnosis = diagnoseQuickExit(info, this.options.probedAssetsDirs);
		}

		this.exitInfoValue = info;
		const summary = `[rpc] ${this.options.command} 已退出：code=${code ?? "null"} signal=${signal ?? "null"} ` +
			`stdout=${stdoutBytes}B messages=${messagesReceived} 存活=${elapsedMs}ms`;
		if (fastExit) {
			logger.error(`${summary}；识别为**秒退**：${info.diagnosis?.summary ?? ""}`);
			for (const line of info.diagnosis?.advice ?? []) {
				logger.error(`[rpc]   → ${line}`);
			}
		} else if (code !== 0 || signal !== null) {
			logger.warn(summary);
		} else {
			logger.debug(summary);
		}

		if (this.spawnError) {
			this.client.fail(
				TuackRpcError.fromUnknown(LocalErrorCode.SpawnFailed, `无法启动 ${this.options.command}`, this.spawnError),
			);
		} else if (!this.shutdownRequested) {
			this.client.fail(buildProcessExitError(this.options.command, info));
		} else {
			this.client.fail(
				TuackRpcError.local(LocalErrorCode.ProcessExited, `${this.options.command} 已退出（正常回收）。`, {
					exitCode: code,
					signal,
				}),
			);
		}

		this.options.onExit?.(info);
		for (const resolve of this.exitResolvers.splice(0, this.exitResolvers.length)) {
			resolve(info);
		}
	}
}

/** 把进程临终信息变成带 `code` 的异常（秒退时 message 里带上诊断）。 */
export function buildProcessExitError(command: string, info: RpcExitInfo): TuackRpcError {
	const data = {
		exitCode: info.code,
		signal: info.signal,
		stdoutBytes: info.stdoutBytes,
		stderr: info.stderr,
		fastExit: info.fastExit,
		diagnosis: info.diagnosis,
	};
	if (info.fastExit && info.diagnosis) {
		const advice = info.diagnosis.advice.length > 0 ? ` ${info.diagnosis.advice[0]}` : "";
		return new TuackRpcError(
			LocalErrorCode.ProcessExited,
			`${command} 启动即退出（exit=${info.code ?? "null"}，stdout 零字节）：${info.diagnosis.summary}${advice}`,
			data,
		);
	}
	return new TuackRpcError(
		LocalErrorCode.ProcessExited,
		`${command} 已退出（exit=${info.code ?? "null"} signal=${info.signal ?? "null"}）。`,
		data,
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 秒退诊断
// ─────────────────────────────────────────────────────────────────────────────

const LANGS_JSON_RE = /langs\.json/i;
const NOT_FOUND_RE = /(enoent|no such file or directory|command not found|not recognized as an internal|无法找到|找不到)/i;

/**
 * 秒退诊断：**这是唯一能让用户在 10 秒内明白「为什么 tuack-ng-rpc 一启动就死」的地方**，
 * 所以文案必须是可操作的（指到确切设置项与已探测目录），而不是「进程退出了」。
 */
export function diagnoseQuickExit(info: RpcExitInfo, probedAssetsDirs?: readonly string[]): QuickExitDiagnosis {
	const stderr = info.stderr;

	if (info.spawnError) {
		const message = info.spawnError.message;
		if (/ENOENT/i.test(message)) {
			return {
				kind: "binary-missing",
				summary: `找不到可执行文件（ENOENT）：${message}`,
				advice: [
					"在设置 tuack.rpcPath 里指定 tuack-ng-rpc 的绝对路径。",
					"或把 tuack-ng-rpc 放到工作区的 tools/ 目录下。",
					"或确保它在 PATH 中。",
				],
			};
		}
		return {
			kind: "spawn-failed",
			summary: `无法启动进程：${message}`,
			advice: ["检查 tuack.rpcPath 指向的文件是否可执行（Linux/macOS 需要 chmod +x）。"],
		};
	}

	if (LANGS_JSON_RE.test(stderr)) {
		const advice = [
			"tuack-ng 启动时**必须**能读到 assets/langs.json，缺失时它会在读取 stdin 之前直接退出（stdout 零字节）。",
			"在设置 tuack.assetsPath 里指向含 langs.json 的 assets 目录。",
			"或把 assets 放到工作区根的 assets/ 目录（debug 构建优先看这里）。",
			"或把 assets 放到 <XDG_DATA_HOME|~/.local/share>/tuack-ng（Windows 为 %LOCALAPPDATA%\\tuack-ng）。",
		];
		if (probedAssetsDirs && probedAssetsDirs.length > 0) {
			advice.push(`已探测的目录：${probedAssetsDirs.join("、")}`);
		}
		return {
			kind: "assets-missing",
			summary: "tuack-ng 找不到 assets/langs.json，启动即退出（stdout 零字节）。此缺失不可降级：连 ren/preview 都不可用。",
			advice,
		};
	}

	if (NOT_FOUND_RE.test(stderr)) {
		return {
			kind: "binary-missing",
			summary: `tuack-ng-rpc 启动失败：stderr 含「找不到」类错误：${firstLine(stderr)}`,
			advice: [
				"确认 tuack.rpcPath / PATH 指向的是真正的 tuack-ng-rpc 二进制。",
				info.code !== null ? `退出码 ${info.code}；stderr 见输出通道。` : "stderr 见输出通道。",
			],
		};
	}

	if (info.signal !== null) {
		return {
			kind: "signaled",
			summary: `进程被信号 ${info.signal} 终止。`,
			advice: ["若并非本扩展发起，检查系统 OOM / 杀毒软件；stderr 见输出通道。"],
		};
	}

	return {
		kind: "unknown",
		summary: `tuack-ng-rpc 启动后立刻退出（exit=${info.code ?? "null"}，stdout 零字节，存活 ${info.elapsedMs}ms）。`,
		advice: [
			stderr.trim().length > 0 ? `stderr：${firstLine(stderr)}` : "stderr 为空，尝试在终端里直接运行 tuack-ng-rpc 复现。",
			"确认二进制与 assets 来自同一个 tuack-ng 版本。",
		],
	};
}

/** 诊断渲染成多行文本（Doctor / 错误提示用）。 */
export function renderQuickExitDiagnosis(info: RpcExitInfo): string {
	const diagnosis = info.diagnosis ?? diagnoseQuickExit(info);
	const lines = [`${diagnosis.summary}`, `命令行退出：code=${info.code ?? "null"} signal=${info.signal ?? "null"} stdout=${info.stdoutBytes}B`];
	if (info.stderr.trim().length > 0) {
		lines.push(`stderr 尾部：\n${indent(info.stderr.trim().split("\n").slice(-10).join("\n"))}`);
	}
	for (const advice of diagnosis.advice) {
		lines.push(`• ${advice}`);
	}
	return lines.join("\n");
}

function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim().length > 0) ?? text;
	return line.trim();
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程树 kill
// ─────────────────────────────────────────────────────────────────────────────

export interface KillTreeOptions {
	/** 子进程是否用 `detached: true` 启动（POSIX 下才能真正杀到整个进程组）。 */
	detached?: boolean;
	/** 超时（毫秒）。 */
	timeoutMs?: number;
	platform?: NodeJS.Platform;
}

/**
 * 杀**进程树**。
 *
 * - Windows：`taskkill /pid <pid> /T /F`（`/T` 才带子进程）。
 * - POSIX：`detached` 启动的子进程自成进程组，用 `kill(-pid)` 一次带走整组；
 *   先 SIGTERM，等不到再 SIGKILL。
 */
export async function killProcessTree(pid: number, options: KillTreeOptions = {}): Promise<void> {
	const platform = options.platform ?? process.platform;
	const timeoutMs = options.timeoutMs ?? 2000;
	if (!isProcessAlive(pid)) {
		return;
	}

	if (platform === "win32") {
		const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		if (result.error) {
			logger.warn(`[rpc] taskkill 失败：${result.error.message}；回退到 child.kill()`);
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && isProcessAlive(pid)) {
			await delay(50);
		}
		return;
	}

	const target = options.detached === false ? pid : -pid;
	signalProcess(target, "SIGTERM", pid);
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && isProcessAlive(pid)) {
		await delay(25);
	}
	if (isProcessAlive(pid)) {
		logger.warn(`[rpc] pid=${pid} 未响应 SIGTERM，发送 SIGKILL。`);
		signalProcess(target, "SIGKILL", pid);
		const killDeadline = Date.now() + Math.min(timeoutMs, 1000);
		while (Date.now() < killDeadline && isProcessAlive(pid)) {
			await delay(25);
		}
	}
}

function signalProcess(target: number, signal: NodeJS.Signals, pid: number): void {
	try {
		process.kill(target, signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") {
			logger.warn(`[rpc] 向 ${target}（pid=${pid}）发送 ${signal} 失败：${describe(error)}`);
		}
	}
}

/** 进程是否存活（EPERM 视为存活）。 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("close", onClose);
			resolve(false);
		}, timeoutMs);
		const onClose = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("close", onClose);
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// 遗留临时目录清理
// ─────────────────────────────────────────────────────────────────────────────

/** tuack-ng 用 `tempfile::TempDir::with_prefix` 创建的目录前缀（源码核实）。 */
export const STALE_TEMP_PREFIXES: readonly string[] = ["tuack-ng-runner-", "tuack-ng-checker-", "tuack-ng-ren-"];

export interface CleanupStaleTempOptions {
	/** 默认系统 temp 目录。 */
	tmpDir?: string;
	prefixes?: readonly string[];
	/** 目录太新（可能是别的活跃实例正在用）就跳过的阈值，默认 6 小时。 */
	minAgeMs?: number;
	/** 只报告不删除。 */
	dryRun?: boolean;
	/** 注入时钟（测试用）。 */
	now?: number;
	/** 判定 pid 是否存活（默认 POSIX 看 /proc）。 */
	isPidAlive?: (pid: number) => boolean;
}

export interface CleanupStaleTempResult {
	removed: string[];
	skipped: { path: string; reason: string }[];
	errors: { path: string; error: string }[];
}

/**
 * 启动时清理本扩展（或崩溃的 tuack-ng 进程）遗留在 temp 里的 `tuack-ng-*` 目录。
 *
 * 保守策略，宁可漏删也不误删：
 * - 只处理目录（跳过文件/符号链接）；
 * - 目录名尾部是数字时视为 pid，pid 还活着就跳过；
 * - 其余目录要求 mtime 早于 `minAgeMs`（默认 6 小时）才删。
 */
export async function cleanupStaleTempDirs(options: CleanupStaleTempOptions = {}): Promise<CleanupStaleTempResult> {
	const tmpDir = options.tmpDir ?? os.tmpdir();
	const prefixes = options.prefixes ?? STALE_TEMP_PREFIXES;
	const minAgeMs = options.minAgeMs ?? 6 * 60 * 60 * 1000;
	const now = options.now ?? Date.now();
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

	const result: CleanupStaleTempResult = { removed: [], skipped: [], errors: [] };

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(tmpDir, { withFileTypes: true });
	} catch (error) {
		result.errors.push({ path: tmpDir, error: describe(error) });
		return result;
	}

	for (const entry of entries) {
		if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) {
			continue;
		}
		const fullPath = path.join(tmpDir, entry.name);
		if (entry.isSymbolicLink() || !entry.isDirectory()) {
			result.skipped.push({ path: fullPath, reason: "不是普通目录（跳过）" });
			continue;
		}
		if (path.dirname(path.resolve(fullPath)) !== path.resolve(tmpDir)) {
			result.skipped.push({ path: fullPath, reason: "不在 temp 目录内（跳过）" });
			continue;
		}

		const pidMatch = /-(\d+)$/.exec(entry.name);
		if (pidMatch && pidMatch[1]) {
			const pid = Number(pidMatch[1]);
			if (isPidAlive(pid)) {
				result.skipped.push({ path: fullPath, reason: `进程 ${pid} 仍存活` });
				continue;
			}
		}

		try {
			const stat = await fs.promises.stat(fullPath);
			if (now - stat.mtimeMs < minAgeMs) {
				result.skipped.push({ path: fullPath, reason: `mtime 太新（${Math.round((now - stat.mtimeMs) / 1000)}s 前）` });
				continue;
			}
		} catch (error) {
			result.errors.push({ path: fullPath, error: describe(error) });
			continue;
		}

		if (options.dryRun) {
			result.skipped.push({ path: fullPath, reason: "dryRun" });
			continue;
		}
		try {
			await fs.promises.rm(fullPath, { recursive: true, force: true });
			result.removed.push(fullPath);
		} catch (error) {
			result.errors.push({ path: fullPath, error: describe(error) });
		}
	}

	if (result.removed.length > 0) {
		logger.info(`[rpc] 已清理 ${result.removed.length} 个遗留临时目录：${result.removed.join("、")}`);
	}
	return result;
}

function defaultIsPidAlive(pid: number): boolean {
	if (pid === process.pid) {
		return false;
	}
	if (process.platform === "linux") {
		try {
			return fs.existsSync(`/proc/${pid}`);
		} catch {
			return false;
		}
	}
	return isProcessAlive(pid);
}
