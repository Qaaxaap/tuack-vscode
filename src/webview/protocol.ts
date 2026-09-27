/**
 * 扩展 ↔ 预览面板的消息协议。不含 DOM 与 VS Code API，两侧都能 import。
 *
 * 所有 line 字段都是预览行号（HTML 上 data-line 的值，1 起，渲染后 Markdown 行号）；
 * 编辑器行到预览行的换算只在扩展侧做。面板隐藏时不推增量，reveal 后前端发 requestUpdate 要一次全量。
 * CSP 由扩展侧注入，前端没有内联脚本；滚动的锁与节流参数见 scrollSync.ts。
 */

import { isSafeUrl } from "../features/preview/sanitize";

/** `createWebviewPanel` 的 viewType（`activationEvents: onWebviewPanel:tuack.preview`）。 */
export const PREVIEW_VIEW_TYPE = "tuack.preview";

// 滚动锁与节流时长在 scrollSync.ts 的 HOST_SCROLL_LOCK_MS / SCROLL_THROTTLE_MS，
// 跟算法放一起，别在这边再定义一份。

// ─────────────────────────────────────────────────────────────────────────────
// 扩展到预览面板
// ─────────────────────────────────────────────────────────────────────────────

/** 全量替换；隐藏期间不发，reveal 后补一次。 */
export interface PreviewUpdateMessage {
	type: "update";
	/** renderMarkdown 产出的 HTML；前端还会用 DOMPurify 再过一遍。 */
	html: string;
	/** 原始 src 到 webview URI 的映射。 */
	assets?: Record<string, string>;
	/** assets 未命中时相对路径的解析基准，一般是题面目录的 webview URI。 */
	baseUri?: string;
	/** 单调递增序号，前端丢弃比已渲染更旧的。 */
	generation: number;
	/** 替换完成后要显示的预览行；不传就保持当前滚动位置。 */
	scrollToLine?: number;
}

/** 编辑器到预览：滚到某个预览行。 */
export interface PreviewScrollToLineMessage {
	type: "scrollToLine";
	/** 预览行号，1 起。 */
	line: number;
	behavior?: "auto" | "smooth";
}

/** 状态条；warnings 直接来自 ren/preview。 */
export interface PreviewStatusMessage {
	type: "status";
	state: "loading" | "ready" | "error";
	message?: string;
	warnings?: string[];
}

export type HostToPreviewMessage =
	| PreviewUpdateMessage
	| PreviewScrollToLineMessage
	| PreviewStatusMessage;

// ─────────────────────────────────────────────────────────────────────────────
// 预览面板到扩展
// ─────────────────────────────────────────────────────────────────────────────

/** 脚本启动完成，恰好一次；扩展应回一条全量 update。 */
export interface PreviewReadyMessage {
	type: "ready";
}

/** 请求全量 update。 */
export interface PreviewRequestUpdateMessage {
	type: "requestUpdate";
	/** visible 表示面板重新可见，隐藏期间的更新已经错过。 */
	reason: "ready" | "visible" | "manual";
}

/** 预览滚动，已节流且已过锁定窗口。 */
export interface PreviewScrollMessage {
	type: "scroll";
	/** 视口顶部的预览行；视口里没有锚点时为 null。 */
	line: number | null;
}

/** 点了链接；扩展决定开浏览器、跳锚点还是定位到编辑器。 */
export interface PreviewOpenLinkMessage {
	type: "openLink";
	href: string;
	/** 被点元素所在的预览行，无法确定时为 null。 */
	line: number | null;
}

/** 点了图片。 */
export interface PreviewOpenImageMessage {
	type: "openImage";
	/** DOM 里当前的 src，命中映射时已经是 webview URI。 */
	src: string;
	/** 改写前的原始 src；没有改写时为 null。 */
	originalSrc: string | null;
	line: number | null;
}

/** 前端日志，扩展侧转发到 Tuack 输出通道。 */
export interface PreviewLogMessage {
	type: "log";
	level: "info" | "warn" | "error";
	message: string;
}

export type PreviewToHostMessage =
	| PreviewReadyMessage
	| PreviewRequestUpdateMessage
	| PreviewScrollMessage
	| PreviewOpenLinkMessage
	| PreviewOpenImageMessage
	| PreviewLogMessage;

// ─────────────────────────────────────────────────────────────────────────────
// 运行时校验；两个方向都按不可信输入处理
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** 前端收到消息后校验。 */
export function isHostToPreviewMessage(value: unknown): value is HostToPreviewMessage {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	switch (value.type) {
		case "update":
			return typeof value.html === "string" && isFiniteNumber(value.generation);
		case "scrollToLine":
			return isFiniteNumber(value.line);
		case "status":
			return value.state === "loading" || value.state === "ready" || value.state === "error";
		default:
			return false;
	}
}

/** 扩展侧收到 webview 消息必须先过这里。 */
export function isPreviewToHostMessage(value: unknown): value is PreviewToHostMessage {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	switch (value.type) {
		case "ready":
			return true;
		case "requestUpdate":
			return value.reason === "ready" || value.reason === "visible" || value.reason === "manual";
		case "scroll":
			return isFiniteNumber(value.line) || value.line === null;
		case "openLink":
			return typeof value.href === "string";
		case "openImage":
			return typeof value.src === "string";
		case "log":
			return typeof value.message === "string";
		default:
			return false;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 图片 URI 改写
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 原始 src 解析成 webview 可加载的 URI：先查 assets，再放行绝对安全 URL，最后按 baseUri 解析。
 * 返回 null 表示别加载（javascript:、未知相对路径），前端应移除 src 而不是让它 404。
 */
export function resolveAssetUri(
	rawSrc: string,
	assets?: Record<string, string>,
	baseUri?: string,
): string | null {
	const src = rawSrc.trim();
	if (src.length === 0) {
		return null;
	}
	const mapped = assets?.[src];
	if (typeof mapped === "string" && mapped.length > 0) {
		return mapped;
	}
	const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src);
	if (hasScheme) {
		return isSafeUrl(src, "src") ? src : null;
	}
	if (baseUri !== undefined && baseUri.length > 0) {
		try {
			return new URL(src, baseUri).toString();
		} catch {
			return null;
		}
	}
	return null;
}

/** warnings 归一化：限条数与单条长度。 */
export function normalizeWarnings(warnings: readonly string[], limit = 20): string[] {
	return warnings
		.filter((warning) => typeof warning === "string" && warning.trim().length > 0)
		.slice(0, limit)
		.map((warning) => (warning.length > 500 ? `${warning.slice(0, 497)}...` : warning));
}
