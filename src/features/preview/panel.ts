/**
 * 预览面板的宿主，VS Code API 细节都收在这里，向 controller 暴露
 * PreviewHostFactory 与 PreviewEnvironment 两个注入实现。
 *
 * CSP 由这里注入，只放行带 nonce 的 bundle；宿主 HTML 要有 base href，相对图片才按题面目录解析，
 * 同文档 #fragment 也才会走本地滚动。不用 retainContextWhenHidden，隐藏期间不推增量。
 */

import { randomBytes } from "node:crypto";
import * as path from "node:path";

import * as vscode from "vscode";

import { logger } from "../../core/log";
import { PREVIEW_VIEW_TYPE, type HostToPreviewMessage } from "../../webview/protocol";
import type {
	PreviewDisposable,
	PreviewEnvironment,
	PreviewHost,
	PreviewHostContext,
	PreviewHostFactory,
	PreviewRestoreTarget,
	PreviewSettings,
	TextDocumentLike,
	UriLike,
} from "./controller";

/** workspaceState 里记录这个面板在看哪份题面。 */
export const PREVIEW_STATE_KEY = "tuack.preview.statement";

interface PersistedPreviewState {
	statementPath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 宿主 HTML，纯函数
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export interface PreviewHtmlOptions {
	title: string;
	/** `webview.cspSource`。 */
	cspSource: string;
	/** media/preview.css 的 webview URI。 */
	styleUri: string;
	/** dist/webview/preview.js 的 webview URI。 */
	scriptUri: string;
	/** 题面目录的 webview URI，写进 base href。 */
	baseUri: string;
	nonce: string;
	/** html lang，缺省 en。 */
	language?: string;
}

/** 生成宿主 HTML。base 要在任何用到相对 URL 的元素之前；link/script 用的是绝对 URI，不受影响。 */
export function buildPreviewHtml(options: PreviewHtmlOptions): string {
	const csp = [
		"default-src 'none'",
		`img-src ${options.cspSource} https: data:`,
		`style-src ${options.cspSource}`,
		`font-src ${options.cspSource}`,
		`script-src 'nonce-${options.nonce}'`,
		`base-uri ${options.cspSource}`,
	].join("; ");
	const language = escapeHtml(options.language ?? "en");
	return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<base href="${escapeHtml(options.baseUri)}">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
</head>
<body class="vscode-body">
<script nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 面板宿主
// ─────────────────────────────────────────────────────────────────────────────

class TuackPreviewPanelHost implements PreviewHost {
	readonly webview: PreviewHost["webview"];

	private readonly panel: vscode.WebviewPanel;
	private readonly memento: vscode.Memento;
	private readonly mediaDir: vscode.Uri;
	private readonly webviewDir: vscode.Uri;
	private context: PreviewHostContext;
	private disposed = false;

	constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		memento: vscode.Memento,
		context: PreviewHostContext,
	) {
		this.panel = panel;
		this.memento = memento;
		this.mediaDir = vscode.Uri.joinPath(extensionUri, "media");
		this.webviewDir = vscode.Uri.joinPath(extensionUri, "dist", "webview");
		this.context = context;

		this.webview = {
			postMessage: (message: HostToPreviewMessage) => this.panel.webview.postMessage(message),
			asWebviewUri: (uri: UriLike) => this.panel.webview.asWebviewUri(uri as vscode.Uri),
			onDidReceiveMessage: (handler: (message: unknown) => void) =>
				this.panel.webview.onDidReceiveMessage(handler),
		};

		// 面板关掉时清持久化状态，免得下次窗口重载又把它恢复出来。
		this.panel.onDidDispose(() => this.clearState());

		this.applyResourceRoots(context);
		this.panel.webview.html = this.renderHtml();
		this.persistState();
	}

	get visible(): boolean {
		return this.panel.visible;
	}

	private applyResourceRoots(context: PreviewHostContext): void {
		// 顺序即优先级：扩展资源、工程根、当前题面目录。
		const roots: vscode.Uri[] = [this.mediaDir, this.webviewDir];
		for (const dir of [context.contestRoot, context.statementDir]) {
			const uri = vscode.Uri.file(dir);
			if (!roots.some((existing) => existing.toString() === uri.toString())) {
				roots.push(uri);
			}
		}
		this.panel.webview.options = { enableScripts: true, localResourceRoots: roots };
	}

	private renderHtml(): string {
		const asWebviewUri = (uri: vscode.Uri): string => this.panel.webview.asWebviewUri(uri).toString();
		return buildPreviewHtml({
			title: this.context.title,
			cspSource: this.panel.webview.cspSource,
			styleUri: asWebviewUri(vscode.Uri.joinPath(this.mediaDir, "preview.css")),
			scriptUri: asWebviewUri(vscode.Uri.joinPath(this.webviewDir, "preview.js")),
			baseUri: asWebviewUri(vscode.Uri.file(this.context.statementDir)),
			nonce: randomBytes(16).toString("hex"),
			language: vscode.env.language,
		});
	}

	private persistState(): void {
		void this.memento.update(PREVIEW_STATE_KEY, { statementPath: this.context.statementPath });
	}

	/** 只有记录里正是本面板时才清，避免误删别的面板的状态。 */
	private clearState(): void {
		const stored = this.memento.get<PersistedPreviewState>(PREVIEW_STATE_KEY);
		if (stored?.statementPath === this.context.statementPath) {
			void this.memento.update(PREVIEW_STATE_KEY, undefined);
		}
	}

	reveal(): void {
		// preserveFocus：预览打开后还能继续在编辑器里打字。
		this.panel.reveal(undefined, true);
	}

	update(context: PreviewHostContext): void {
		if (this.disposed) {
			return;
		}
		const statementDirChanged = context.statementDir !== this.context.statementDir;
		this.context = context;
		this.panel.title = context.title;
		this.applyResourceRoots(context);
		if (statementDirChanged) {
			// base href 变了必须重设 html，会触发一次 webview 重载、前端重新发 ready。
			this.panel.webview.html = this.renderHtml();
		}
		this.persistState();
	}

	onDidDispose(handler: () => void): PreviewDisposable {
		return this.panel.onDidDispose(handler);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearState();
		this.panel.dispose();
	}
}

export interface PreviewHostFactoryOptions {
	extensionUri: vscode.Uri;
	/** 面板状态记忆（`context.workspaceState`）。 */
	memento: vscode.Memento;
}

/** 创建 `PreviewHostFactory`：按需创建 `tuack.preview` 面板。 */
export function createPreviewHostFactory(options: PreviewHostFactoryOptions): PreviewHostFactory {
	return {
		create(createOptions: PreviewHostContext & { beside: boolean }): PreviewHost {
			const panel = vscode.window.createWebviewPanel(
				PREVIEW_VIEW_TYPE,
				createOptions.title,
				createOptions.beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
				{ enableScripts: true, enableFindWidget: true },
			);
			const host = new TuackPreviewPanelHost(
				panel,
				options.extensionUri,
				options.memento,
				createOptions,
			);
			// 控制器拿到宿主后自己 reveal()。
			return host;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 面板恢复
// ─────────────────────────────────────────────────────────────────────────────

export interface RegisterPreviewSerializerOptions {
	context: vscode.ExtensionContext;
	extensionUri: vscode.Uri;
	target: PreviewRestoreTarget;
}

/** 注册 WebviewPanelSerializer（package.json 里已声明 onWebviewPanel）。恢复出来的面板交回控制器接管。 */
export function registerPreviewSerializer(options: RegisterPreviewSerializerOptions): vscode.Disposable {
	return vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, {
		async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown): Promise<void> {
			const stored = options.context.workspaceState.get<PersistedPreviewState>(PREVIEW_STATE_KEY);
			const statementPath = stored?.statementPath;
			if (typeof statementPath !== "string" || statementPath.length === 0) {
				logger.debug("[preview] 没有可恢复的题面路径，关闭恢复出来的预览面板。");
				panel.dispose();
				return;
			}
			const statementDir = path.dirname(statementPath);
			// 先用占位 context 把面板建起来，控制器 restore() 会立刻用真实 scope 覆盖。
			const host = new TuackPreviewPanelHost(panel, options.extensionUri, options.context.workspaceState, {
				title: path.basename(statementDir),
				statementDir,
				contestRoot: statementDir,
				statementPath,
			});
			const restored = await options.target.restore(host, statementPath);
			if (!restored) {
				host.dispose();
			}
		},
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// 环境实现：控制器用的 VS Code 边界
// ─────────────────────────────────────────────────────────────────────────────

/** 用真实的 VS Code API 实现 PreviewEnvironment。 */
export function createVscodePreviewEnvironment(context: vscode.ExtensionContext): PreviewEnvironment {
	let statusBar: vscode.StatusBarItem | undefined;
	const ensureStatusBar = (): vscode.StatusBarItem => {
		if (!statusBar) {
			statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
		}
		return statusBar;
	};
	context.subscriptions.push({ dispose: () => statusBar?.dispose() });

	return {
		activeDocument(): TextDocumentLike | undefined {
			return vscode.window.activeTextEditor?.document;
		},

		activeEditorTopLine(): number | undefined {
			const range = vscode.window.activeTextEditor?.visibleRanges[0];
			return range === undefined ? undefined : range.start.line + 1;
		},

		readSettings(resource: UriLike | undefined): PreviewSettings {
			const configuration = vscode.workspace.getConfiguration("tuack", resource as vscode.Uri | undefined);
			const debounceMs = configuration.get<number>("preview.debounceMs", 300);
			const template = configuration.get<string | null>("preview.defaultTemplate", null);
			return {
				debounceMs: Number.isFinite(debounceMs) ? Math.max(0, debounceMs) : 300,
				saveBeforePreview: configuration.get<boolean>("preview.saveBeforePreview", true),
				defaultTemplate:
					typeof template === "string" && template.trim().length > 0 ? template.trim() : null,
			};
		},

		onDidChangeTextDocument(handler): PreviewDisposable {
			return vscode.workspace.onDidChangeTextDocument((event) => handler(event.document));
		},

		onDidSaveTextDocument(handler): PreviewDisposable {
			return vscode.workspace.onDidSaveTextDocument((document) => handler(document));
		},

		onDidChangeConfiguration(handler): PreviewDisposable {
			return vscode.workspace.onDidChangeConfiguration((event) => handler((section) => event.affectsConfiguration(section)));
		},

		onDidChangeEditorVisibleRange(handler): PreviewDisposable {
			return vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
				const range = event.visibleRanges[0];
				if (range !== undefined) {
					handler(event.textEditor.document.uri, range.start.line + 1);
				}
			});
		},

		async save(uri: UriLike): Promise<boolean> {
			// ren/preview 只读磁盘，这里必须真的落盘。
			const target = uri as vscode.Uri;
			const document = vscode.workspace.textDocuments.find(
				(candidate) => candidate.uri.toString() === target.toString(),
			);
			if (document !== undefined) {
				// 没脏就算成功，避免 workspace.save 对未打开或未脏文档返回 undefined 造成误判。
				return document.isDirty ? document.save() : true;
			}
			return (await vscode.workspace.save(target)) !== undefined;
		},

		async revealEditorLine(uri: UriLike, line: number): Promise<void> {
			const target = uri as vscode.Uri;
			const position = new vscode.Position(Math.max(0, Math.floor(line) - 1), 0);
			const range = new vscode.Range(position, position);
			const visible = vscode.window.visibleTextEditors.find(
				(editor) => editor.document.uri.toString() === target.toString(),
			);
			if (visible !== undefined) {
				visible.selection = new vscode.Selection(position, position);
				visible.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
				return;
			}
			const document = await vscode.workspace.openTextDocument(target);
			const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		},

		openExternal(href: string): Promise<boolean> {
			return Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(href)));
		},

		openResource(uri: UriLike): Promise<unknown> {
			return Promise.resolve(vscode.commands.executeCommand("vscode.open", uri as vscode.Uri));
		},

		showWarning(message: string): void {
			void vscode.window.showWarningMessage(message);
		},

		showInformation(message: string): void {
			void vscode.window.showInformationMessage(message);
		},

		fileUri(fsPath: string): UriLike {
			return vscode.Uri.file(fsPath);
		},

		setStatusBar(text: string | undefined, tooltip?: string): void {
			if (text === undefined) {
				statusBar?.hide();
				return;
			}
			const item = ensureStatusBar();
			item.text = `$(open-preview) ${text}`;
			item.tooltip = tooltip ?? text;
			item.command = "tuack.preview.show";
			item.show();
		},

		translate(message: string, ...args: Array<string | number>): string {
			return args.length > 0 ? vscode.l10n.t(message, ...args) : vscode.l10n.t(message);
		},

		log(level, message): void {
			logger[level](message);
		},

		now(): number {
			return Date.now();
		},
	};
}
