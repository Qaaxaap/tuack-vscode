/**
 * 题面预览的**会话控制器**：把 `ren/preview`（RPC）→ `renderMarkdown`（渲染）→
 * 预览面板（webview）串起来，并负责滚动同步、图片资源改写与 in-flight 单飞。
 *
 * ## 为什么这个文件不 import `vscode`
 *
 * 预览的核心逻辑（找题目、防抖、保存策略、单飞、行号换算、消息分发）全是可测的纯逻辑，
 * 只有「窗口/文档/面板」这些边角需要 VS Code API。因此这里把 VS Code 依赖收成两个注入接口
 * （`PreviewEnvironment` / `PreviewHostFactory`），`panel.ts` 提供真实实现，
 * 单测用假实现直接跑——**不需要 `vi.mock("vscode")`**（vitest 里根本没有 vscode 模块）。
 *
 * ## 三个容易踩的硬事实（改代码前请先读）
 *
 * 1. **`ren/preview` 只读磁盘上的 `statement.md`**：缓冲区里未保存的编辑不会进预览。
 *    所以 `tuack.preview.saveBeforePreview`（默认 true）决定预览前是否 `workspace.save()`；
 *    关掉它时必须在预览状态条/状态栏上写明「预览基于已保存内容」，否则用户会以为扩展坏了。
 * 2. **`scope` 必须精确到 `<day>/<problem>`**：否则服务端返回 `-32602`。
 *    day/problem 一律从磁盘上的 `conf.json`（`folder: "contest" | "day" | "problem"`）向上找出来，
 *    不猜路径；`makeScope()` 负责转义。
 * 3. **`ren/preview` / `config/*` 是同步 handler**，会阻塞该进程的读循环。频繁编辑时必须
 *    **in-flight 单飞**（同一时刻只发一个请求），新请求合并成一次尾随重发，否则请求会排队堆积。
 *
 * ## 行号空间
 *
 * 所有进出面板的 `line` 都是**预览行号**（渲染后 Markdown 行号 = HTML 的 `data-line`）。
 * 编辑器行 ↔ 预览行的换算只在这里做（`lineMapSync`），webview 不收 `lineMap`。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
	isPreviewToHostMessage,
	normalizeWarnings,
	type HostToPreviewMessage,
} from "../../webview/protocol";
import { HOST_SCROLL_LOCK_MS, SCROLL_THROTTLE_MS } from "../../webview/scrollSync";
import {
	makeScope,
	type MethodName,
	type MethodParams,
	type MethodResult,
	type SessionId,
} from "../../rpc/protocol";
import type { RpcCallOptions } from "../../rpc/client";
import { buildLineMapIndex, type LineMapIndex } from "./lineMapSync";
import { renderMarkdown, type RenderResult } from "./render";

/** 题面文件名（`package.json` 的 editor/title 菜单也按这个名字挂）。 */
export const STATEMENT_FILE_NAME = "statement.md";
/** tuack 的配置文件名，contest/day/problem 三层同名。 */
export const CONF_FILE_NAME = "conf.json";

/**
 * `ren/preview` 的调用超时。它是同步 handler，大工程的 MiniJinja 展开可能偏慢；
 * 给 30s（与 `DEFAULT_CALL_TIMEOUT_MS` 一致）比默认值更明确。
 */
export const PREVIEW_CALL_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// 注入接口（VS Code 边界）
// ─────────────────────────────────────────────────────────────────────────────

/** 结构上兼容 `vscode.Uri`（只需要 fsPath 与 toString）。 */
export interface UriLike {
	readonly fsPath: string;
	toString(): string;
}

/** 结构上兼容 `vscode.Disposable`。 */
export interface PreviewDisposable {
	dispose(): void;
}

/** 结构上兼容 `vscode.TextDocument`（只用得到这几个字段）。 */
export interface TextDocumentLike {
	readonly uri: UriLike;
	readonly isDirty: boolean;
	readonly languageId?: string;
}

/** 面板的 webview 表面（结构上兼容 `vscode.Webview`）。 */
export interface PreviewWebviewSurface {
	postMessage(message: HostToPreviewMessage): unknown;
	asWebviewUri(uri: UriLike): UriLike;
	onDidReceiveMessage(handler: (message: unknown) => void): PreviewDisposable;
}

/** 面板上下文：标题 + 题面目录（`localResourceRoots` / `<base href>`）+ 持久化用的题面路径。 */
export interface PreviewHostContext {
	title: string;
	/** 题面所在目录（绝对路径）。 */
	statementDir: string;
	/** 竞赛工程根（含 `folder:"contest"` 的 conf.json 的那一级）。 */
	contestRoot: string;
	/** `statement.md` 的绝对路径（面板状态持久化用）。 */
	statementPath: string;
}

/** 一个预览面板宿主。 */
export interface PreviewHost {
	readonly webview: PreviewWebviewSurface;
	/** 面板是否可见。不可见时**不推全量 update**（不保留隐藏上下文，重新可见时前端会要一次）。 */
	readonly visible: boolean;
	/** 把面板带到前台，但不抢焦点（用户还要在编辑器里打字）。 */
	reveal(): void;
	/** 复用面板时重定向到另一道题（更新标题、资源根与 `<base href>`）。 */
	update(context: PreviewHostContext): void;
	onDidDispose(handler: () => void): PreviewDisposable;
	dispose(): void;
}

export interface PreviewHostFactory {
	create(options: PreviewHostContext & { beside: boolean }): PreviewHost;
}

/** 面板反序列化后交回控制器（`panel.ts` 的 `WebviewPanelSerializer` 用）。 */
export interface PreviewRestoreTarget {
	restore(host: PreviewHost, statementPath: string): Promise<boolean>;
}

/** 预览相关设置的快照（按资源解析，`scope: resource`）。 */
export interface PreviewSettings {
	debounceMs: number;
	saveBeforePreview: boolean;
	defaultTemplate: string | null;
}

/**
 * 控制器需要的全部 VS Code 能力。真实实现见 `panel.ts::createVscodePreviewEnvironment()`。
 */
export interface PreviewEnvironment {
	/** 当前活动编辑器对应的文档（没有则 undefined）。 */
	activeDocument(): TextDocumentLike | undefined;
	/** 当前活动编辑器视口顶部行（1 起），用于首次打开时定位。 */
	activeEditorTopLine(): number | undefined;
	readSettings(resource: UriLike | undefined): PreviewSettings;
	onDidChangeTextDocument(handler: (document: TextDocumentLike) => void): PreviewDisposable;
	onDidSaveTextDocument(handler: (document: TextDocumentLike) => void): PreviewDisposable;
	onDidChangeConfiguration(handler: (affects: (section: string) => boolean) => void): PreviewDisposable;
	onDidChangeEditorVisibleRange(handler: (uri: UriLike, topLine: number) => void): PreviewDisposable;
	/** `workspace.save()`：返回是否真的保存成功。 */
	save(uri: UriLike): Promise<boolean>;
	/** 在编辑器里定位某个源文件的某一行（1 起）。 */
	revealEditorLine(uri: UriLike, line: number): Promise<void>;
	openExternal(href: string): Promise<boolean>;
	openResource(uri: UriLike): Promise<unknown>;
	showWarning(message: string): void;
	showInformation(message: string): void;
	fileUri(fsPath: string): UriLike;
	/** 预览状态栏项：`undefined` 表示隐藏。 */
	setStatusBar(text: string | undefined, tooltip?: string): void;
	/** 走 `vscode.l10n.t`。 */
	translate(message: string, ...args: Array<string | number>): string;
	/** 转发到 Tuack 输出通道。 */
	log(level: "trace" | "debug" | "info" | "warn" | "error", message: string): void;
	now(): number;
}

/**
 * 控制器用到的 RPC 表面。
 *
 * `RpcPool` 自身在构造时就固定了 `workspaceUri`，而「竞赛工程根」要等解析出题面才知道；
 * 因此 `extension.ts` 用一个惰性适配器包住池：`openWorkspace()` 负责「按需 spawn / 换根重建」，
 * `call()` 转发到池。结构上等价于 `RpcPool` 的那部分能力，测试里给假实现即可。
 */
export interface PreviewRpc {
	/** 确保底层会话指向这个竞赛工程根（首次调用会 spawn P1）。 */
	openWorkspace(contestRootFsPath: string): Promise<void>;
	call<M extends MethodName>(
		method: M,
		params: MethodParams<M>,
		options?: RpcCallOptions,
	): Promise<MethodResult<M>>;
	controlSessionId(): SessionId | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 题面定位：从 statement.md 向上找 conf.json
// ─────────────────────────────────────────────────────────────────────────────

/** 文件探测（单测注入桩；默认实现走 node:fs）。 */
export interface FileProbe {
	exists(filePath: string): boolean;
	readFile(filePath: string): string | null;
}

export const nodeFileProbe: FileProbe = {
	exists(filePath: string): boolean {
		try {
			return fs.statSync(filePath).isFile();
		} catch {
			return false;
		}
	},
	readFile(filePath: string): string | null {
		try {
			return fs.readFileSync(filePath, "utf8");
		} catch {
			return null;
		}
	},
};

/** 一个可预览的题目定位结果。 */
export interface PreviewTarget {
	/** 绝对路径。 */
	statementPath: string;
	/** 绝对路径（题面目录，通常就是题目目录）。 */
	statementDir: string;
	/** 竞赛工程根绝对路径。 */
	contestRoot: string;
	/** scope 用的 day key（目录名）。 */
	day: string;
	/** scope 用的 problem key（目录名）。 */
	problem: string;
	/** `makeScope(day, problem)`，可直接传给 `ren/preview`。 */
	scope: string;
}

function safeParseJson(text: string | null): Record<string, unknown> | undefined {
	if (text === null) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 从 `statement.md` 向上找竞赛工程根（`conf.json` 里 `folder === "contest"`），
 * 再按 conf 的层级 / 相对路径推出 `<day>/<problem>`。
 *
 * 为什么认 conf 而不是猜目录名代价：tuack-ng 的 scope key 就是目录名，
 * 但工程根未必是工作区根（可能是子目录），所以必须从题面往上找。
 */
export function resolvePreviewTarget(
	statementPath: string,
	probe: FileProbe = nodeFileProbe,
): PreviewTarget | undefined {
	const absoluteStatement = path.resolve(statementPath);
	const statementDir = path.dirname(absoluteStatement);

	let contestRoot: string | undefined;
	let dayDir: string | undefined;
	let problemDir: string | undefined;

	let dir = statementDir;
	for (;;) {
		const confPath = path.join(dir, CONF_FILE_NAME);
		if (probe.exists(confPath)) {
			const parsed = safeParseJson(probe.readFile(confPath));
			const folder = typeof parsed?.folder === "string" ? parsed.folder : undefined;
			if (folder === "contest") {
				contestRoot = dir;
				break;
			}
			if (folder === "problem") {
				problemDir = dir;
			} else if (folder === "day") {
				dayDir = dir;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	if (contestRoot === undefined) {
		return undefined;
	}

	// 相对路径兜底：<contest>/<day>/<problem>/statement.md
	const relative = path.relative(contestRoot, statementDir);
	const segments = relative.split(path.sep).filter((segment) => segment.length > 0 && segment !== ".");

	const day = dayDir !== undefined ? path.basename(dayDir) : segments[0];
	const problem =
		problemDir !== undefined ? path.basename(problemDir) : segments.length >= 2 ? segments[1] : undefined;

	if (day === undefined || problem === undefined) {
		return undefined;
	}

	return {
		statementPath: absoluteStatement,
		statementDir,
		contestRoot,
		day,
		problem,
		scope: makeScope(day, problem),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 控制器
// ─────────────────────────────────────────────────────────────────────────────

export interface PreviewControllerOptions {
	rpc: PreviewRpc;
	env: PreviewEnvironment;
	hosts: PreviewHostFactory;
	/** 渲染函数（默认 `renderMarkdown`，测试可注入）。 */
	render?(markdown: string): RenderResult;
	probe?: FileProbe;
}

/** `show()` 的入参：文档 + 放哪一列。 */
export interface ShowPreviewOptions {
	beside: boolean;
}

function uriKey(uri: UriLike): string {
	return uri.toString();
}

function hasScheme(value: string): boolean {
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/** 把 `error.advice`（`BinaryNotFoundError` 之类）拼进提示，保证错误可操作。 */
export function describePreviewError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error !== null && typeof error === "object" && Array.isArray((error as { advice?: unknown }).advice)) {
		const advice = ((error as { advice: unknown[] }).advice ?? []).filter(
			(item): item is string => typeof item === "string" && item.trim().length > 0,
		);
		if (advice.length > 0) {
			return `${message}\n• ${advice.slice(0, 3).join("\n• ")}`;
		}
	}
	return message;
}

/**
 * 预览会话控制器。
 *
 * 生命周期：`show()/restore()` 打开（或复用）面板 → 面板发 `ready`/`requestUpdate` →
 * 拉 `ren/preview` → 渲染 → 全量 `update`；文档变化走防抖、保存走即时刷新。
 */
export class PreviewController implements PreviewRestoreTarget, PreviewDisposable {
	private readonly rpc: PreviewRpc;
	private readonly env: PreviewEnvironment;
	private readonly hosts: PreviewHostFactory;
	private readonly render: (markdown: string) => RenderResult;
	private readonly probe: FileProbe;

	private readonly subscriptions: PreviewDisposable[] = [];
	private readonly hostDisposables: PreviewDisposable[] = [];

	private host: PreviewHost | undefined;
	private target: PreviewTarget | undefined;
	private documentUri: UriLike | undefined;
	private index: LineMapIndex | undefined;

	private generation = 0;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private inFlight = false;
	private queued = false;

	private needsConfigReload = false;
	/** 当前预览相关的「脏文档」（题面 + 工程内的 conf.json），`saveBeforePreview` 时统一保存。 */
	private readonly dirty = new Map<string, UriLike>();
	/** 正在由控制器主动保存的文档数：期间收到的 save 事件不触发二次刷新。 */
	private saving = 0;

	private lastEditorRevealAt = 0;
	/** 编辑器可见行的节流状态：按 URI 合并，`SCROLL_THROTTLE_MS` 窗口内只回推一次。 */
	private visibleRangeTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly pendingVisibleRanges = new Map<string, { uri: UriLike; topLine: number }>();
	private pendingScrollSourceLine: number | undefined;
	/** 前端是否已经发过 `ready`（之前的全量 update 已经到过它手上）。 */
	private frontendReady = false;
	private disposed = false;

	constructor(options: PreviewControllerOptions) {
		this.rpc = options.rpc;
		this.env = options.env;
		this.hosts = options.hosts;
		this.render = options.render ?? renderMarkdown;
		this.probe = options.probe ?? nodeFileProbe;

		// 全局订阅一次即可：内部按 documentUri / contestRoot 过滤。
		this.subscriptions.push(
			this.env.onDidChangeTextDocument((document) => this.onDocumentChanged(document)),
			this.env.onDidSaveTextDocument((document) => this.onDocumentSaved(document)),
			this.env.onDidChangeConfiguration((affects) => this.onConfigurationChanged(affects)),
			this.env.onDidChangeEditorVisibleRange((uri, topLine) => this.onEditorVisibleRange(uri, topLine)),
		);
	}

	// ── 公开入口（命令） ────────────────────────────────────────────────────

	/** `tuack.preview.show` / `tuack.preview.showToSide`：预览当前活动文档。 */
	async showActive(options: ShowPreviewOptions): Promise<boolean> {
		const document = this.env.activeDocument();
		if (!document) {
			this.env.showInformation(this.env.translate("Tuack: open statement.md first, then show the preview."));
			return false;
		}
		return this.show(document, options);
	}

	/** 用指定文档打开（或复用）预览面板。 */
	async show(document: TextDocumentLike, options: ShowPreviewOptions): Promise<boolean> {
		if (this.disposed) {
			return false;
		}
		const statementPath = document.uri.fsPath;
		if (path.basename(statementPath) !== STATEMENT_FILE_NAME) {
			this.env.showInformation(
				this.env.translate("Tuack: only {0} can be previewed as a problem statement.", STATEMENT_FILE_NAME),
			);
			return false;
		}

		const target = resolvePreviewTarget(statementPath, this.probe);
		if (!target) {
			this.env.showWarning(
				this.env.translate(
					"Tuack: {0} is not inside a Tuack contest (no conf.json with folder=contest found above it).",
					statementPath,
				),
			);
			return false;
		}

		this.documentUri = document.uri;
		this.pendingScrollSourceLine = this.env.activeEditorTopLine();
		this.setTarget(target, options.beside);
		await this.runPreview();
		return true;
	}

	/** `tuack.preview.refresh`：强制重拉一次（面板不可见时也能刷新，下次可见即最新）。 */
	refresh(): void {
		if (this.disposed) {
			return;
		}
		if (!this.host || !this.target) {
			this.env.showInformation(
				this.env.translate("Tuack: no preview is open yet. Run \"Tuack: Show Preview\" first."),
			);
			return;
		}
		this.requestPreview();
	}

	/** `WebviewPanelSerializer`：面板被 VS Code 恢复后重新接管。 */
	async restore(host: PreviewHost, statementPath: string): Promise<boolean> {
		if (this.disposed) {
			host.dispose();
			return false;
		}
		const target = resolvePreviewTarget(statementPath, this.probe);
		if (!target) {
			this.env.log("warn", `[preview] 无法恢复预览：${statementPath} 不在 Tuack 工程内。`);
			host.dispose();
			return false;
		}
		this.documentUri = this.env.fileUri(target.statementPath);
		this.adoptHost(host, target);
		await this.runPreview();
		return true;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		this.resetVisibleRangeThrottle();
		for (const subscription of this.subscriptions.splice(0, this.subscriptions.length)) {
			subscription.dispose();
		}
		this.disposeHost();
		this.env.setStatusBar(undefined);
	}

	// ── 面板装配 ────────────────────────────────────────────────────────────

	private setTarget(target: PreviewTarget, beside: boolean): void {
		const existing = this.host;
		const changed = existing === undefined || this.target?.scope !== target.scope;
		this.target = target;

		let host = existing;
		if (existing === undefined) {
			host = this.hosts.create({
				beside,
				title: this.previewTitle(target),
				statementDir: target.statementDir,
				contestRoot: target.contestRoot,
				statementPath: target.statementPath,
			});
			this.host = host;
			this.frontendReady = false;
			this.attachHost(host);
		} else if (changed) {
			// 同一面板切到另一道题：localResourceRoots 与 <base href> 都要跟着换。
			existing.update({
				title: this.previewTitle(target),
				statementDir: target.statementDir,
				contestRoot: target.contestRoot,
				statementPath: target.statementPath,
			});
			// `<base href>` 变了会重设 html → webview 重载 → 前端会重新发 ready。
			this.frontendReady = false;
			this.index = undefined;
		}
		host?.reveal();
	}

	private adoptHost(host: PreviewHost, target: PreviewTarget): void {
		this.disposeHost();
		this.target = target;
		this.host = host;
		this.frontendReady = false;
		this.attachHost(host);
		host.update({
			title: this.previewTitle(target),
			statementDir: target.statementDir,
			contestRoot: target.contestRoot,
			statementPath: target.statementPath,
		});
		this.index = undefined;
	}

	private attachHost(host: PreviewHost): void {
		this.hostDisposables.push(
			host.webview.onDidReceiveMessage((message) => this.onMessage(message)),
			host.onDidDispose(() => this.onHostDisposed()),
		);
	}

	private onHostDisposed(): void {
		// 用户关掉面板：停掉宿主订阅，但保留全局订阅（下次 show 复用同一个控制器）。
		for (const disposable of this.hostDisposables.splice(0, this.hostDisposables.length)) {
			disposable.dispose();
		}
		this.resetVisibleRangeThrottle();
		this.host = undefined;
		this.index = undefined;
		this.frontendReady = false;
		this.env.setStatusBar(undefined);
	}

	/** 丢弃节流窗口里还没回推的编辑器位置（面板关了/换了，旧位置没有意义）。 */
	private resetVisibleRangeThrottle(): void {
		if (this.visibleRangeTimer !== undefined) {
			clearTimeout(this.visibleRangeTimer);
			this.visibleRangeTimer = undefined;
		}
		this.pendingVisibleRanges.clear();
	}

	private disposeHost(): void {
		for (const disposable of this.hostDisposables.splice(0, this.hostDisposables.length)) {
			disposable.dispose();
		}
		this.resetVisibleRangeThrottle();
		const host = this.host;
		this.host = undefined;
		host?.dispose();
	}

	private previewTitle(target: PreviewTarget): string {
		return this.env.translate("Tuack Preview: {0}", `${target.day}/${target.problem}`);
	}

	// ── 面板 → 扩展 ─────────────────────────────────────────────────────────

	private onMessage(raw: unknown): void {
		if (!isPreviewToHostMessage(raw)) {
			// webview 属不可信输入：形状不对就只记日志。
			this.env.log("warn", `[preview] 忽略无法识别的面板消息：${JSON.stringify(raw)}`);
			return;
		}
		switch (raw.type) {
			case "ready":
				this.frontendReady = true;
				this.requestPreview();
				break;
			case "requestUpdate":
				this.requestPreview();
				break;
			case "scroll":
				this.onPreviewScroll(raw.line);
				break;
			case "openLink":
				void this.onOpenLink(raw.href, raw.line);
				break;
			case "openImage":
				void this.onOpenImage(raw.src, raw.originalSrc);
				break;
			case "log":
				this.env.log(raw.level, `[preview:webview] ${raw.message}`);
				break;
			default:
				break;
		}
	}

	// ── 拉取 / 渲染 / 推送 ──────────────────────────────────────────────────

	/** in-flight 单飞：飞行中只记一个「还要再来一次」，落地后合并成一次尾随请求。 */
	private requestPreview(): void {
		if (this.disposed) {
			return;
		}
		if (this.inFlight) {
			this.queued = true;
			return;
		}
		void this.runPreview();
	}

	private async runPreview(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const host = this.host;
		const target = this.target;
		if (!host || !target) {
			return;
		}

		this.inFlight = true;
		try {
			await this.rpc.openWorkspace(target.contestRoot);
			const settings = this.env.readSettings(this.documentUri);
			this.postStatus(host, "loading");

			// ⚠️ ren/preview 只读磁盘：先按设置保存，再（必要时）reload 配置，最后才 preview。
			if (settings.saveBeforePreview) {
				await this.saveDirtyDocuments();
				this.env.setStatusBar(undefined);
			} else {
				this.env.setStatusBar(
					this.env.translate("Tuack: preview shows the saved file"),
					this.env.translate(
						"Unsaved changes are not included because tuack.preview.saveBeforePreview is off.",
					),
				);
			}

			if (this.needsConfigReload) {
				await this.reloadConfig(target);
			}

			const template = settings.defaultTemplate?.trim();
			const scope = target.scope;
			const result = await this.rpc.call(
				"ren/preview",
				template !== undefined && template.length > 0
					? { sessionId: this.sessionId(), scope, template }
					: { sessionId: this.sessionId(), scope },
				{ timeoutMs: PREVIEW_CALL_TIMEOUT_MS },
			);

			// RPC 响应按不可信输入处理：字段可能缺省/类型漂移。
			const markdown = typeof result?.markdown === "string" ? result.markdown : String(result?.markdown ?? "");
			const lineMap = Array.isArray(result?.lineMap) ? result.lineMap : [];
			const warnings = normalizeWarnings(Array.isArray(result?.warnings) ? result.warnings : []);

			const rendered = this.render(markdown);
			this.index = buildLineMapIndex(lineMap, rendered.anchors);

			const scrollToLine = this.consumePendingScrollLine();
			const assets = this.buildAssets(host, target, rendered.html);
			const baseUri = host.webview.asWebviewUri(this.env.fileUri(target.statementDir)).toString();
			const generation = ++this.generation;

			const message: HostToPreviewMessage = {
				type: "update",
				html: rendered.html,
				generation,
				baseUri,
			};
			if (Object.keys(assets).length > 0) {
				message.assets = assets;
			}
			if (scrollToLine !== undefined) {
				message.scrollToLine = scrollToLine;
			}
			if (host.visible || !this.frontendReady) {
				await host.webview.postMessage(message);
			} else {
				// 不保留隐藏上下文：隐藏期间不推送，重新可见时前端会发 requestUpdate(reason:"visible")。
				this.env.log("debug", "[preview] 面板不可见，跳过本次全量 update。");
			}

			this.postStatus(
				host,
				"ready",
				settings.saveBeforePreview
					? undefined
					: this.env.translate(
							"Preview is based on the saved file on disk; unsaved changes are not included (tuack.preview.saveBeforePreview = false).",
						),
				warnings,
			);
		} catch (error) {
			const message = describePreviewError(error);
			this.env.log("error", `[preview] 渲染预览失败：${message}`);
			this.postStatus(host, "error", message);
		} finally {
			this.inFlight = false;
			if (this.queued) {
				this.queued = false;
				// 尾随重发：期间可能有新的编辑/请求，合并成一次。
				this.requestPreview();
			}
		}
	}

	private sessionId(): SessionId {
		// 池会把 params.sessionId 改写成目标进程自己的 session；这里给空串占位。
		return this.rpc.controlSessionId() ?? "";
	}

	private async reloadConfig(target: PreviewTarget): Promise<void> {
		try {
			await this.rpc.call("config/reload", { sessionId: this.sessionId(), scope: target.scope });
			this.needsConfigReload = false;
			this.env.log("debug", `[preview] conf.json 已变化，config/reload scope=${target.scope}。`);
		} catch (error) {
			// reload 失败不致命：下一次 preview 仍会按旧缓存渲染，用户可手动刷新。
			this.env.log("warn", `[preview] config/reload 失败（继续预览）：${describePreviewError(error)}`);
			this.needsConfigReload = false;
		}
	}

	private consumePendingScrollLine(): number | undefined {
		const sourceLine = this.pendingScrollSourceLine;
		this.pendingScrollSourceLine = undefined;
		if (sourceLine === undefined || this.index === undefined) {
			return undefined;
		}
		return this.index.renderedForSource(sourceLine).line ?? undefined;
	}

	/**
	 * 把渲染后 HTML 里的相对 `<img src>` 映射成 webview URI。
	 *
	 * 前端在未命中映射时还会用 `baseUri` 兜底；这里做映射是为了：
	 * ① 让题面目录之外的相对图片（如 `../common/a.png`）也能解析；
	 * ② 提前过滤掉磁盘上不存在的路径，避免 webview 里出现 404 破图。
	 */
	private buildAssets(host: PreviewHost, target: PreviewTarget, html: string): Record<string, string> {
		const assets: Record<string, string> = {};
		const pattern = /<img\b[^>]*?\bsrc="([^"]*)"/gi;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(html)) !== null) {
			const raw = match[1];
			if (raw === undefined || raw.length === 0 || raw.startsWith("#") || hasScheme(raw)) {
				continue;
			}
			let relative = raw;
			try {
				relative = decodeURIComponent(raw);
			} catch {
				// 保留原样（不是合法百分号编码）。
			}
			relative = (relative.split("?")[0] ?? "").split("#")[0] ?? "";
			if (relative.length === 0) {
				continue;
			}
			const absolute = path.resolve(target.statementDir, relative);
			if (!this.probe.exists(absolute)) {
				continue;
			}
			assets[raw] = host.webview.asWebviewUri(this.env.fileUri(absolute)).toString();
		}
		return assets;
	}

	private postStatus(
		host: PreviewHost,
		state: "loading" | "ready" | "error",
		message?: string,
		warnings?: string[],
	): void {
		const payload: HostToPreviewMessage = { type: "status", state };
		if (message !== undefined && message.length > 0) {
			payload.message = message;
		}
		if (warnings !== undefined && warnings.length > 0) {
			payload.warnings = warnings;
		}
		void host.webview.postMessage(payload);
	}

	// ── 滚动同步 ────────────────────────────────────────────────────────────

	/** 预览 → 编辑器：面板报来视口顶部的预览行。 */
	private onPreviewScroll(previewLine: number | null): void {
		if (previewLine === null || this.index === undefined || this.documentUri === undefined) {
			return;
		}
		const resolved = this.index.sourceForRendered(previewLine);
		if (resolved.line === null) {
			return;
		}
		this.lastEditorRevealAt = this.env.now();
		void this.env.revealEditorLine(this.documentUri, resolved.line).catch((error: unknown) => {
			this.env.log("warn", `[preview] 定位编辑器行失败：${describePreviewError(error)}`);
		});
	}

	/**
	 * 编辑器 → 预览：编辑器视口顶部行。
	 *
	 * - `HOST_SCROLL_LOCK_MS`（200ms）内忽略回声：刚由预览推动过编辑器，反方向的
	 *   `visibleRanges` 事件是我们的回响，不是用户操作；
	 * - 之后按 `SCROLL_THROTTLE_MS`（50ms）**节流并按 URI 合并**（与内置 Markdown 预览一致），
	 *   高频滚动只回推最后一个位置。
	 */
	private onEditorVisibleRange(uri: UriLike, topSourceLine: number): void {
		if (this.disposed || this.host === undefined || this.documentUri === undefined) {
			return;
		}
		if (uriKey(uri) !== uriKey(this.documentUri)) {
			return;
		}
		if (this.env.now() - this.lastEditorRevealAt < HOST_SCROLL_LOCK_MS) {
			return;
		}
		this.pendingVisibleRanges.set(uriKey(uri), { uri, topLine: topSourceLine });
		if (this.visibleRangeTimer !== undefined) {
			return;
		}
		this.visibleRangeTimer = setTimeout(() => this.flushEditorVisibleRanges(), SCROLL_THROTTLE_MS);
	}

	private flushEditorVisibleRanges(): void {
		this.visibleRangeTimer = undefined;
		const pending = [...this.pendingVisibleRanges.values()];
		this.pendingVisibleRanges.clear();
		if (this.disposed || this.host === undefined || this.index === undefined) {
			return;
		}
		for (const { topLine } of pending) {
			const resolved = this.index.renderedForSource(topLine);
			if (resolved.line !== null) {
				void this.host.webview.postMessage({ type: "scrollToLine", line: resolved.line });
			}
		}
	}

	// ── 文档 / 配置事件 ─────────────────────────────────────────────────────

	private isTargetDocument(document: TextDocumentLike): boolean {
		return this.documentUri !== undefined && uriKey(document.uri) === uriKey(this.documentUri);
	}

	/** 文档是否属于当前预览的竞赛工程（含 contest/day/problem 三层 conf.json）。 */
	private isProjectConfig(fsPath: string): boolean {
		const target = this.target;
		if (target === undefined || path.basename(fsPath) !== CONF_FILE_NAME) {
			return false;
		}
		const relative = path.relative(target.contestRoot, path.resolve(fsPath));
		return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
	}

	private onDocumentChanged(document: TextDocumentLike): void {
		if (this.disposed) {
			return;
		}
		if (this.isTargetDocument(document)) {
			this.dirty.set(uriKey(document.uri), document.uri);
			this.schedulePreview();
			return;
		}
		if (this.isProjectConfig(document.uri.fsPath)) {
			// conf.json 改了：preview 的配置取自 session 缓存，必须先 config/reload。
			this.needsConfigReload = true;
			this.dirty.set(uriKey(document.uri), document.uri);
			this.schedulePreview();
		}
	}

	private onDocumentSaved(document: TextDocumentLike): void {
		if (this.disposed) {
			return;
		}
		const key = uriKey(document.uri);
		this.dirty.delete(key);
		if (this.saving > 0) {
			// 是控制器自己为预览发起的保存，当前这轮 runPreview 会继续，不需要再排队。
			return;
		}
		if (this.isTargetDocument(document)) {
			this.schedulePreview(0);
			return;
		}
		if (this.isProjectConfig(document.uri.fsPath)) {
			this.needsConfigReload = true;
			this.schedulePreview(0);
		}
	}

	private onConfigurationChanged(affects: (section: string) => boolean): void {
		if (this.disposed || !affects("tuack.preview")) {
			return;
		}
		// 设置（防抖 / 保存策略 / 默认模板）每轮都重新读取，因此只需排一次刷新。
		this.env.log("debug", "[preview] tuack.preview.* 设置变化，下一次预览立即生效。");
		if (this.host !== undefined) {
			this.schedulePreview(0);
		}
	}

	private schedulePreview(delayMs?: number): void {
		if (this.host === undefined || this.target === undefined) {
			return;
		}
		const settings = this.env.readSettings(this.documentUri);
		const delay = Math.max(0, delayMs ?? settings.debounceMs);
		if (this.debounceTimer !== undefined) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.requestPreview();
		}, delay);
	}

	private async saveDirtyDocuments(): Promise<void> {
		// 题面本身**总是**尝试保存一次（`env.save` 对未脏文档是 no-op，成本极低）；
		// 否则「用户改了但还没触发过 change 事件就点了预览」会漏保存——而 ren/preview 只读磁盘。
		const pending = new Map<string, UriLike>();
		if (this.documentUri !== undefined) {
			pending.set(uriKey(this.documentUri), this.documentUri);
		}
		for (const [key, uri] of this.dirty) {
			pending.set(key, uri);
		}
		if (pending.size === 0) {
			return;
		}
		this.saving += 1;
		try {
			for (const [key, uri] of pending) {
				try {
					const saved = await this.env.save(uri);
					if (saved) {
						this.dirty.delete(key);
					}
				} catch (error) {
					this.env.log("warn", `[preview] 保存文档失败（继续预览磁盘上的旧内容）：${describePreviewError(error)}`);
				}
			}
		} finally {
			this.saving -= 1;
		}
	}

	// ── 链接 / 图片 ─────────────────────────────────────────────────────────

	private async onOpenLink(href: string, line: number | null): Promise<void> {
		const target = this.target;
		if (target === undefined || href.length === 0) {
			return;
		}
		if (href.startsWith("#")) {
			// 同文档锚点：webview 已 preventDefault，不会自己导航；markdown 渲染没有 heading id，
			// 这里保持 no-op 只记日志（`<base href>` 保证它不会被当成外部链接）。
			this.env.log("debug", `[preview] 忽略同文档锚点链接 ${href}（预览行 ${line ?? "?"}）。`);
			return;
		}
		if (hasScheme(href)) {
			try {
				await this.env.openExternal(href);
			} catch (error) {
				this.env.log("warn", `[preview] 打开外部链接失败 ${href}：${describePreviewError(error)}`);
			}
			return;
		}
		// 相对链接：优先在编辑器里打开本地文件（题面里常见 `./xxx.md`、`../p2/statement.md`）。
		const resolved = path.resolve(target.statementDir, href.split("?")[0] ?? href);
		if (this.probe.exists(resolved)) {
			try {
				await this.env.openResource(this.env.fileUri(resolved));
				return;
			} catch (error) {
				this.env.log("warn", `[preview] 打开本地链接失败 ${resolved}：${describePreviewError(error)}`);
			}
		}
		this.env.log("warn", `[preview] 无法解析链接：${href}（预览行 ${line ?? "?"}）。`);
	}

	private async onOpenImage(src: string, originalSrc: string | null): Promise<void> {
		const target = this.target;
		if (target === undefined) {
			return;
		}
		// 改写后的 `src` 是 webview URI，真正可打开的是改写前的原始路径。
		const raw = originalSrc ?? src;
		if (raw.length === 0 || hasScheme(raw)) {
			if (hasScheme(raw) && !raw.startsWith("file:")) {
				this.env.log("debug", `[preview] 图片是外部/内联资源，交给 webview 显示：${raw}`);
				return;
			}
		}
		const withoutScheme = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
		const resolved = path.isAbsolute(withoutScheme) ? withoutScheme : path.resolve(target.statementDir, withoutScheme);
		if (!this.probe.exists(resolved)) {
			this.env.log("warn", `[preview] 图片不存在：${resolved}`);
			return;
		}
		try {
			await this.env.openResource(this.env.fileUri(resolved));
		} catch (error) {
			this.env.log("warn", `[preview] 打开图片失败 ${resolved}：${describePreviewError(error)}`);
		}
	}
}
