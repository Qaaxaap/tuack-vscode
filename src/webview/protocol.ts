/**
 * 「扩展 ↔ 预览面板」的消息协议。
 *
 * ⚠️ 这是 webview 与扩展之间的**唯一**契约：前端只认这里的消息类型，扩展侧按这里的形状
 * 发消息，并用 `isPreviewToHostMessage` 校验前端发回来的消息（webview 属不可信输入）。
 *
 * ## 行号约定（与 VS Code 内置 Markdown 预览对齐）
 *
 * 所有 `line` 字段都是**预览行号**：预览 HTML 里 `data-line="<n>"` 的 `n`，
 * 即 MiniJinja 展开后 Markdown 的行号（1 起）。锚点属性沿用内置预览的 `data-line`，
 * 因此内置 `scroll-sync.ts` 的选择器与查找逻辑可以直接复用。
 *
 * 编辑器行（`statement.md`）↔ 预览行的换算**由扩展侧负责**：
 * `buildLineMapIndex(lineMap, anchors).renderedForSource(editorLine)` /
 * `.sourceForRendered(previewLine)`（`{% for %}` 循环体没有精确映射时回退到最近锚点）。
 * webview 不需要也不接收 `lineMap`，只做两件事：按 `data-line` 定位、把视口里的 `data-line` 报回来。
 *
 * ## 其它约束（设计 §4.5）
 *
 * - CSP 由扩展侧注入，前端没有内联脚本、不用 `eval`；
 * - 不用 `retainContextWhenHidden`：面板隐藏期间**不推增量**，`reveal` 后前端发
 *   `requestUpdate`（reason `"visible"`）让扩展补一次**全量** `update`；
 * - 全量 `update` 带 `generation` 单调序号，前端据此丢弃过期消息；
 * - 前端不自己导航：点链接/图片只发消息，交给扩展决定。
 * - **滚动锁定**：任一方向主动发起滚动后，在锁定窗口内忽略反方向事件，避免两边互相打架
 *   （与内置 Markdown 预览一致）。窗口时长与节流参数定义在 `src/webview/scrollSync.ts`：
 *   `HOST_SCROLL_LOCK_MS`（宿主侧锁）、`SCROLL_THROTTLE_MS`（两侧节流）。
 *
 * 本文件不含 DOM 与 VS Code API，扩展侧与 webview 侧都可以安全 import。
 */

import { isSafeUrl } from "../features/preview/sanitize";

/** `createWebviewPanel` 的 viewType（`activationEvents: onWebviewPanel:tuack.preview`）。 */
export const PREVIEW_VIEW_TYPE = "tuack.preview";

// 滚动锁定与节流的时长常量已迁到 `src/webview/scrollSync.ts`
// （`HOST_SCROLL_LOCK_MS` / `SCROLL_THROTTLE_MS`），它们来自对 VS Code 内置
// Markdown 预览实现的核对，因此与滚动算法放在一起，避免两处定义漂移。

// ─────────────────────────────────────────────────────────────────────────────
// 扩展 → 预览面板
// ─────────────────────────────────────────────────────────────────────────────

/** 全量替换预览内容；隐藏期间不发，`reveal` 后补发一次。 */
export interface PreviewUpdateMessage {
	type: "update";
	/** 扩展侧用 `renderMarkdown()` 产出的 HTML（已消毒，前端仍会用 DOMPurify 再过一遍）。 */
	html: string;
	/** 原始 `src` → webview URI 的映射（题面图片改写用）。 */
	assets?: Record<string, string>;
	/** `assets` 未命中时，相对路径的解析基准（通常是题面所在目录的 webview URI）。 */
	baseUri?: string;
	/** 单调递增的全量序号：小于已渲染序号的消息必须丢弃。 */
	generation: number;
	/** 替换完成后要显示的预览行（`data-line` 空间）；缺省表示保持当前滚动位置。 */
	scrollToLine?: number;
}

/** 滚动到某个预览行（编辑器 → 预览方向；扩展侧已把编辑器行换算成预览行）。 */
export interface PreviewScrollToLineMessage {
	type: "scrollToLine";
	/** 预览行号（1 起，`data-line` 空间）。 */
	line: number;
	behavior?: "auto" | "smooth";
}

/** 状态条：加载中 / 正常 / 错误，以及 `ren/preview` 的 warnings。 */
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
// 预览面板 → 扩展
// ─────────────────────────────────────────────────────────────────────────────

/** 前端脚本启动完成（恰好一次）。扩展应回一条全量 `update`。 */
export interface PreviewReadyMessage {
	type: "ready";
}

/** 请求一次全量 `update`。 */
export interface PreviewRequestUpdateMessage {
	type: "requestUpdate";
	/** `ready` = 初次加载；`visible` = 面板重新可见（隐藏期间的更新已错过）；`manual` = 手动刷新。 */
	reason: "ready" | "visible" | "manual";
}

/** 预览滚动（已节流、已过锁定窗口）。 */
export interface PreviewScrollMessage {
	type: "scroll";
	/** 视口顶部对应的预览行（`data-line` 空间）；视口里没有锚点时为 `null`。 */
	line: number | null;
}

/** 点击预览里的链接：扩展决定打开外部浏览器、跳转锚点还是在编辑器里定位。 */
export interface PreviewOpenLinkMessage {
	type: "openLink";
	href: string;
	/** 被点击元素所在的预览行（`data-line` 空间），无法确定时为 `null`。 */
	line: number | null;
}

/** 点击预览里的图片（含未命中 assets 映射的原始 src）。 */
export interface PreviewOpenImageMessage {
	type: "openImage";
	/** DOM 里当前的 `src`（命中 assets 映射时就是改写后的 webview URI）。 */
	src: string;
	/** 改写前的原始 `src`；没有改写时为 `null`。 */
	originalSrc: string | null;
	line: number | null;
}

/** 前端调试日志（扩展侧应转发到 Tuack 输出通道）。 */
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
// 运行时校验（两个方向都按不可信输入处理）
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** 前端收消息后校验。 */
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

/** 扩展侧收到 webview 消息后**必须**先过这个函数。 */
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
 * 把题面里的原始 `src` 解析成 webview 可加载的 URI。
 *
 * 优先级：扩展侧显式映射（`assets`）→ 已是绝对安全 URL（http/https/`data:image/*`…）
 * → 相对 `baseUri` 解析。返回 `null` 表示"不要加载"（例如 `javascript:`、未知相对路径），
 * 前端应移除该 `src` 而不是让它变成一次 404 请求。
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

/** 供状态条展示的 warnings 归一化：限制条数与单条长度，避免面板被刷屏。 */
export function normalizeWarnings(warnings: readonly string[], limit = 20): string[] {
	return warnings
		.filter((warning) => typeof warning === "string" && warning.trim().length > 0)
		.slice(0, limit)
		.map((warning) => (warning.length > 500 ? `${warning.slice(0, 497)}...` : warning));
}
