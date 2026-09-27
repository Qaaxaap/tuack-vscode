/**
 * 题面预览面板的前端，独立打包成 dist/webview/preview.js（IIFE + browser）。
 *
 * 不能 import vscode，也不能有内联脚本 / eval / new Function；CSP 由扩展侧注入，只放行带 nonce 的这份 bundle。
 * 扩展负责取数与渲染，这里插 HTML（DOMPurify 二次消毒）、做滚动同步、上报点击；宿主 HTML 不用提供元素。
 */

import DOMPurify from "dompurify";

import {
	isHostToPreviewMessage,
	resolveAssetUri,
	type PreviewToHostMessage,
	type PreviewUpdateMessage,
} from "./protocol";
import {
	SCROLL_THROTTLE_MS,
	createScrollLock,
	createThrottle,
	getEditorLineNumberForPageOffset,
	getLineForNode,
	scrollToRevealLine,
} from "./scrollSync";

/** 视口顶部往下偏一点当"当前行"，避免卡在元素边界来回抖。 */
const VIEWPORT_TOP_OFFSET = 8;

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare const acquireVsCodeApi: () => VsCodeApi;

/** 存在 webview state 里的最小状态：当前停留的预览行。 */
interface PersistedState {
	line?: number | null;
}

interface Layout {
	status: HTMLElement;
	scroller: HTMLElement;
	content: HTMLElement;
}

class PreviewPanel {
	private readonly vscode: VsCodeApi = acquireVsCodeApi();
	private readonly status: HTMLElement;
	private readonly scroller: HTMLElement;
	private readonly content: HTMLElement;

	private generation = -1;
	/** 几何缓存的重建令牌，每次 update 换一个。 */
	private layoutToken = 0;
	/** 第 1 层锁：程序化滚动期间丢弃 scroll 事件。 */
	private readonly scrollLock = createScrollLock();
	/** 第 3 层：50ms 节流；位置在回调里才算，避免每次 scroll 都读几何。 */
	private readonly reportThrottle = createThrottle<void>(SCROLL_THROTTLE_MS, () => {
		this.reportScroll(this.currentTopLine());
	});
	private lastReportedLine: number | null | undefined;
	private restoreLine: number | null = null;

	constructor(layout: Layout) {
		this.status = layout.status;
		this.scroller = layout.scroller;
		this.content = layout.content;

		const state = this.readState();
		this.restoreLine = state.line ?? null;

		// passive：滚动高频，别阻塞滚动线程。
		this.scroller.addEventListener("scroll", () => this.onScroll(), { passive: true });
		this.content.addEventListener("click", (event) => this.onClick(event));
		window.addEventListener("message", (event) => this.onMessage(event));
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible" && this.generation >= 0) {
				// 隐藏期间扩展不推更新，回来时主动要一次全量。
				this.post({ type: "requestUpdate", reason: "visible" });
			}
		});
		// 尺寸变化要让几何缓存失效。
		window.addEventListener("resize", () => this.invalidateLayout());
		if (typeof ResizeObserver !== "undefined") {
			new ResizeObserver(() => this.invalidateLayout()).observe(this.content);
		}
	}

	private invalidateLayout(): void {
		this.layoutToken += 1;
	}

	/** 告诉扩展脚本已就绪，等它回一条全量 update。 */
	start(): void {
		this.post({ type: "ready" });
	}

	private post(message: PreviewToHostMessage): void {
		this.vscode.postMessage(message);
	}

	private readState(): PersistedState {
		const state = this.vscode.getState();
		if (typeof state === "object" && state !== null && "line" in state) {
			const line = (state as PersistedState).line;
			return { line: typeof line === "number" ? line : null };
		}
		return {};
	}

	private onMessage(event: MessageEvent): void {
		const data: unknown = event.data;
		if (!isHostToPreviewMessage(data)) {
			return;
		}
		if (data.type === "update") {
			this.update(data);
			return;
		}
		if (data.type === "scrollToLine") {
			this.scrollToLine(data.line, data.behavior ?? "auto");
			return;
		}
		this.showStatus(data.state, data.message, data.warnings);
	}

	// ── 全量更新 ────────────────────────────────────────────────────────────

	private update(message: PreviewUpdateMessage): void {
		// 过期消息丢弃；序号相同表示扩展重发同一份内容，允许幂等重建。
		if (message.generation < this.generation) {
			return;
		}
		// 先记下当前位置，避免刷新后跳回顶部。
		const previousLine = this.currentTopLine();
		this.generation = message.generation;
		this.layoutToken += 1;
		this.scrollLock.reset();
		this.reportThrottle.cancel();

		// DOMPurify 是浏览器里的权威消毒；RETURN_DOM_FRAGMENT 直接拿 fragment 插入，不用 innerHTML。
		const clean = DOMPurify.sanitize(message.html, { RETURN_DOM_FRAGMENT: true });
		this.content.replaceChildren(clean);
		this.applyAssets(message.assets, message.baseUri);

		const target = message.scrollToLine ?? this.restoreLine ?? previousLine;
		this.restoreLine = null;
		if (target !== null && target !== undefined) {
			this.scrollToLine(target, "auto");
		}
	}

	/** 应用 assets 映射；解析失败的图片移除 src，免得 404。 */
	private applyAssets(assets?: Record<string, string>, baseUri?: string): void {
		this.content.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
			const raw = image.getAttribute("src");
			if (raw === null) {
				return;
			}
			const resolved = resolveAssetUri(raw, assets, baseUri);
			if (resolved === null) {
				image.removeAttribute("src");
				image.classList.add("tuack-missing-asset");
				return;
			}
			if (resolved !== raw) {
				image.dataset.tuackOriginalSrc = raw;
				image.setAttribute("src", resolved);
			}
		});
	}

	// ── 滚动同步 ────────────────────────────────────────────────────────────

	/** 视口顶部对应的预览行。 */
	private currentTopLine(): number | null {
		return getEditorLineNumberForPageOffset(
			this.scroller,
			this.content,
			VIEWPORT_TOP_OFFSET,
			this.layoutToken,
		);
	}

	private onScroll(): void {
		// 锁的判定放事件入口（内置 scrollDisabledCount 同款）。
		if (this.scrollLock.locked) {
			return;
		}
		this.reportThrottle.call();
	}

	private reportScroll(line: number | null): void {
		// trailing 可能落在锁定期内，这里再判一次。
		if (this.scrollLock.locked || line === this.lastReportedLine) {
			return;
		}
		this.lastReportedLine = line;
		this.post({ type: "scroll", line });
		this.vscode.setState({ line } satisfies PersistedState);
	}

	/** 编辑器到预览：滚到某预览行，期间抑制反向回报。 */
	private scrollToLine(line: number, behavior: ScrollBehavior): void {
		this.scrollLock.acquire();
		this.reportThrottle.cancel();
		this.lastReportedLine = Math.floor(line);
		scrollToRevealLine(this.scroller, this.content, line, behavior, this.layoutToken);
	}

	// ── 点击事件 ────────────────────────────────────────────────────────────

	private onClick(event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		const anchor = target.closest("a[href]");
		if (anchor instanceof HTMLAnchorElement) {
			// 不导航，交给扩展决定。
			event.preventDefault();
			this.post({
				type: "openLink",
				href: anchor.getAttribute("href") ?? "",
				line: getLineForNode(anchor),
			});
			return;
		}
		const image = target.closest("img");
		if (image instanceof HTMLImageElement) {
			this.post({
				type: "openImage",
				src: image.getAttribute("src") ?? "",
				originalSrc: image.dataset.tuackOriginalSrc ?? null,
				line: getLineForNode(image),
			});
		}
	}

	// ── 状态条 ──────────────────────────────────────────────────────────────

	private showStatus(state: "loading" | "ready" | "error", message?: string, warnings?: string[]): void {
		const parts: string[] = [];
		if (message !== undefined && message.trim().length > 0) {
			parts.push(message.trim());
		}
		for (const warning of warnings ?? []) {
			if (warning.trim().length > 0) {
				parts.push(warning.trim());
			}
		}
		if (state === "ready" && parts.length === 0) {
			this.status.hidden = true;
			this.status.textContent = "";
			this.status.dataset.state = state;
			return;
		}
		this.status.hidden = false;
		this.status.dataset.state = state;
		// 用 textContent：warnings 来自 tuack-ng，按不可信输入处理。
		this.status.textContent = parts.join("\n");
	}
}

/** 找宿主给的元素，缺了自建，所以宿主 HTML 不需要任何约定。 */
function ensureLayout(): Layout {
	const existingStatus = document.getElementById("tuack-preview-status");
	const existingScroller = document.getElementById("tuack-preview-scroller");
	const existingContent = document.getElementById("tuack-preview-content");
	if (existingStatus !== null && existingScroller !== null && existingContent !== null) {
		return { status: existingStatus, scroller: existingScroller, content: existingContent };
	}

	const status = existingStatus ?? document.createElement("div");
	status.id = "tuack-preview-status";
	status.className = "tuack-preview-status";
	status.hidden = true;

	const scroller = existingScroller ?? document.createElement("div");
	scroller.id = "tuack-preview-scroller";
	scroller.className = "tuack-preview-scroller";

	const content = existingContent ?? document.createElement("article");
	content.id = "tuack-preview-content";
	content.className = "tuack-preview-content";

	if (existingContent === null) {
		scroller.append(content);
	}
	if (existingScroller === null) {
		document.body.append(status, scroller);
	} else if (existingStatus === null) {
		document.body.prepend(status);
	}
	return { status, scroller, content };
}

function boot(): void {
	try {
		const panel = new PreviewPanel(ensureLayout());
		panel.start();
	} catch (error) {
		// 初始化失败也要让扩展看到，别静默白屏。
		const message = error instanceof Error ? error.message : String(error);
		try {
			acquireVsCodeApi().postMessage({ type: "log", level: "error", message: `预览前端初始化失败：${message}` });
		} catch {
			// ignore
		}
	}
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
	boot();
}
