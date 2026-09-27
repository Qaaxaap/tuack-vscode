/**
 * 预览面板侧的滚动同步：**照搬 VS Code 内置 Markdown 预览**
 * （`markdown-language-features/preview-src/scroll-sync.ts` + `preview-src/index.ts`）。
 *
 * 依据：`.cache/research/scroll-sync-调研.md`（含上游源码逐条核对）。
 *
 * 与内置一致的要点：
 * - 锚点属性 `data-line`（值 = 该块级元素对应的 Markdown 行号，1 起）；`<ul>`/`<ol>` 跳过，
 *   围栏代码块的锚点在 `<code>` 上、读取时归到 `<pre>` 并算出 `endLine`；
 * - 反方向（预览 → 行号）是**纯几何二分**：对可见锚点按 `top` 二分，取跨越视口偏移的
 *   `{previous, next}`，再分段插值；`elementFromPoint` 只作为二分取不到时的回退；
 * - 正方向（行号 → 位置）三档插值：多行块内按"扣掉 padding 的内容区"比例、否则在
 *   previous 底边与 next 顶边之间插值、再否则按块内小数行比例；
 * - 三层防回环锁：webview 计数器（50/100/200ms，单个 timer）+ 宿主 200ms `isScrolling`
 *   （由预览控制器实现，用本文件导出的常量）+ 两侧 50ms 节流；
 * - `Math.max(1, …)` 钳制滚动目标（压过 webview 自身的自动回滚）。
 *
 * 本文件**模块顶层不碰 DOM**：纯算术与锁/节流逻辑可以直接在 vitest（node 环境）里测，
 * 只有 `collectCodeLineElements` 之后的 DOM 层函数需要 F5 实测。
 *
 * 行号空间：全部是「预览行号」（`data-line` 的值）。编辑器行 ↔ 预览行的换算在扩展侧
 * （`buildLineMapIndex`），本文件不做映射。
 */

import { SOURCE_LINE_ATTRIBUTES, anchorSelector } from "../features/preview/lineMapSync";

// ─────────────────────────────────────────────────────────────────────────────
// 可复用的时间常量（宿主侧锁与节流用同一份，避免两侧参数漂移）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * webview 程序化滚动后的抑制档位：连续发起时按 50 → 100 → 200ms 递增
 * （复用同一个 timer，后设覆盖先设），对应内置的 `scrollDisabledCount`。
 */
export const SCROLL_LOCK_DELAYS_MS: readonly number[] = [50, 100, 200];

/** 宿主侧 `isScrolling` 锁时长（收到预览滚动后抑制把 visibleRanges 回推给预览）。 */
export const HOST_SCROLL_LOCK_MS = 200;

/** 双向滚动事件的节流窗口（编辑器侧与预览侧都用它）。 */
export const SCROLL_THROTTLE_MS = 50;

/** snap zone：目标已在视口 `viewportHeight * ratio` 范围内就不滚，减少无意义跳动。 */
export const SNAP_ZONE_RATIO = 0.25;

/** 滚动目标下限：内置用 `Math.max(1, …)` 压过 webview 的自动回滚。 */
export const MIN_SCROLL_TARGET = 1;

// ─────────────────────────────────────────────────────────────────────────────
// 纯算术（DOM-free，可单测）
// ─────────────────────────────────────────────────────────────────────────────

/** 一个锚点块的几何信息；坐标一律相对**内容容器顶部**。 */
export interface LineBounds {
	/** 预览行号（1 起；正方向换算允许小数）。 */
	line: number;
	/** 该块最后一行行号；普通块 == `line`，代码块 > `line`。 */
	endLine: number;
	/** 元素上沿。 */
	top: number;
	/** 元素整体高度（含 padding/border）。 */
	height: number;
	/** 多行块：扣掉 padding/border 后的内容区上沿。 */
	contentTop: number;
	/** 多行块：扣掉 padding/border 后的内容区高度。 */
	contentHeight: number;
}

/** 跨越某个位置的两个锚点；两端都可能为 `null`（在所有锚点之前/之后）。 */
export interface LinePair {
	previous: LineBounds | null;
	next: LineBounds | null;
}

function isMultiLineBlock(bounds: LineBounds): boolean {
	return bounds.endLine > bounds.line;
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}

/**
 * 内置的 `getLineElementsAtPageOffset`：按 `top` 二分，取跨越 `offset` 的 `{previous, next}`。
 * `bounds` 必须按文档顺序（从而 `top` 单调不减）排列。
 */
export function findLinePair(bounds: readonly LineBounds[], offset: number): LinePair | null {
	if (bounds.length === 0) {
		return null;
	}
	let low = 0;
	let high = bounds.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const candidate = bounds[mid];
		if (candidate !== undefined && candidate.top <= offset) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return {
		previous: low > 0 ? bounds[low - 1] ?? null : null,
		next: low < bounds.length ? bounds[low] ?? null : null,
	};
}

/** 正方向用：最后一个 `line <= target` 的锚点，以及它后面的锚点。 */
export function findBoundsForLine(bounds: readonly LineBounds[], line: number): LinePair {
	if (bounds.length === 0) {
		return { previous: null, next: null };
	}
	let low = 0;
	let high = bounds.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const candidate = bounds[mid];
		if (candidate !== undefined && candidate.line <= line) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return {
		previous: low > 0 ? bounds[low - 1] ?? null : null,
		next: low < bounds.length ? bounds[low] ?? null : null,
	};
}

/**
 * 预览位置 → 预览行号（内置 `getEditorLineNumberForPageOffset` 的插值部分）。
 *
 * 返回小数行号（上游用它映射到行内字符列）；调用方若要整数自行取整。
 */
export function lineForPageOffset(pair: LinePair | null, offset: number): number | null {
	if (pair === null) {
		return null;
	}
	const { previous, next } = pair;

	if (previous === null) {
		return next === null ? null : next.line;
	}

	if (next !== null && previous.line !== next.line) {
		// 多行块（代码块）：按内容区比例换算到 `endLine` 区间。
		if (isMultiLineBlock(previous)) {
			const fraction = clamp01(
				previous.contentHeight > 0 ? (offset - previous.contentTop) / previous.contentHeight : 0,
			);
			return previous.line + fraction * (previous.endLine - previous.line);
		}
		// 普通块：在 previous 底边与 next 顶边之间插值。
		const previousBottom = previous.top + previous.height;
		const span = next.top - previousBottom;
		if (span <= 0) {
			return previous.line;
		}
		return previous.line + clamp01((offset - previousBottom) / span) * (next.line - previous.line);
	}

	// 越过了最后一个锚点（或两个锚点同一行）。
	if (next === null && isMultiLineBlock(previous)) {
		const fraction = clamp01(
			previous.contentHeight > 0 ? (offset - previous.contentTop) / previous.contentHeight : 0,
		);
		return previous.line + fraction * (previous.endLine - previous.line);
	}
	return previous.line;
}

/**
 * 预览行号 → 预览位置（内置 `scrollToRevealSourceLine` 的三档插值）。
 * 返回相对内容容器顶部的偏移；调用方负责转成 `scrollTop` 并做 `Math.max(1, …)` 钳制。
 */
export function pageOffsetForLine(pair: LinePair, line: number): number {
	const { previous, next } = pair;
	if (previous === null) {
		return next === null ? 0 : next.top;
	}
	// 1) 落在多行块内（含首行）：按内容区比例。
	if (isMultiLineBlock(previous) && line >= previous.line && line <= previous.endLine) {
		const span = previous.endLine - previous.line;
		const fraction = span > 0 ? (line - previous.line) / span : 0;
		return previous.contentTop + previous.contentHeight * fraction;
	}
	if (line <= previous.line) {
		return previous.top;
	}
	// 2) 在 previous 底边与 next 顶边之间插值。
	if (next !== null && next.line > previous.line) {
		const previousBottom = previous.top + previous.height;
		const fraction = (line - previous.line) / (next.line - previous.line);
		return previousBottom + (next.top - previousBottom) * fraction;
	}
	// 3) 没有 next：按块内小数行比例（内置同款）。
	const fraction = line - Math.floor(line);
	return previous.top + previous.height * fraction;
}

/** snap zone 判定：当前滚动位置与目标位置足够近就不滚（目标已在视口上部）。 */
export function isWithinSnapZone(current: number, target: number, viewportHeight: number): boolean {
	const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
	return Math.abs(current - target) <= height * SNAP_ZONE_RATIO;
}

// ─────────────────────────────────────────────────────────────────────────────
// 三层防回环锁：第 1 层（webview 计数器）与第 3 层（节流）
// ─────────────────────────────────────────────────────────────────────────────

export interface TimerDeps {
	/** 默认 `window.setTimeout`；测试注入假 timer。 */
	setTimer?: (callback: () => void, delayMs: number) => number;
	clearTimer?: (handle: number) => void;
}

function defaultTimerDeps(): Required<TimerDeps> {
	return {
		setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
		clearTimer: (handle) => window.clearTimeout(handle),
	};
}

export interface ScrollLock {
	/** `scroll` 监听首行判断：锁定期内直接丢弃事件。 */
	readonly locked: boolean;
	/** 每次程序化滚动前调用；连续调用时抑制窗口按 50 → 100 → 200ms 递增。 */
	acquire(): void;
	/** 立即解锁（面板重渲染/可见性变化时）。 */
	reset(): void;
}

/**
 * 内置 `scrollDisabledCount` + 单一 timer 的等价实现。
 *
 * 计数 > 0 期间忽略 scroll 事件；每次 `acquire` 重置同一个 timer，
 * 因此连续的程序化滚动会依次获得 50、100、200ms 的抑制窗口（第 4 次起保持 200ms）。
 */
export function createScrollLock(
	delays: readonly number[] = SCROLL_LOCK_DELAYS_MS,
	deps: TimerDeps = {},
): ScrollLock {
	const { setTimer, clearTimer } = { ...defaultTimerDeps(), ...deps };
	const fallbackDelay = delays.length > 0 ? delays[delays.length - 1] ?? 0 : 0;
	let count = 0;
	let step = 0;
	let handle: number | undefined;

	const clear = (): void => {
		count = 0;
		step = 0;
		if (handle !== undefined) {
			clearTimer(handle);
			handle = undefined;
		}
	};

	return {
		get locked(): boolean {
			return count > 0;
		},
		acquire(): void {
			count += 1;
			step = Math.min(step + 1, Math.max(1, delays.length));
			if (handle !== undefined) {
				clearTimer(handle);
			}
			const delay = delays[step - 1] ?? fallbackDelay;
			handle = setTimer(() => {
				handle = undefined;
				count = 0;
				step = 0;
			}, delay);
		},
		reset: clear,
	};
}

export interface Throttle<T> {
	/** 首次立即执行，窗口内的后续调用合并成 trailing 一次。 */
	call(value: T): void;
	cancel(): void;
}

export interface ThrottleDeps extends TimerDeps {
	now?: () => number;
}

/** lodash `throttle` 的最小实现（leading + trailing），用于 50ms 合并滚动事件。 */
export function createThrottle<T>(
	intervalMs: number,
	run: (value: T) => void,
	deps: ThrottleDeps = {},
): Throttle<T> {
	const { setTimer, clearTimer } = { ...defaultTimerDeps(), ...deps };
	const now = deps.now ?? (() => Date.now());
	let lastRunAt = Number.NEGATIVE_INFINITY;
	let handle: number | undefined;
	let pending: { value: T } | undefined;

	const invoke = (value: T): void => {
		lastRunAt = now();
		run(value);
	};

	return {
		call(value: T): void {
			const elapsed = now() - lastRunAt;
			if (!(elapsed < intervalMs)) {
				// 首次调用或已过窗口：立即执行，并丢弃挂起的 trailing。
				if (handle !== undefined) {
					clearTimer(handle);
					handle = undefined;
				}
				pending = undefined;
				invoke(value);
				return;
			}
			pending = { value };
			if (handle === undefined) {
				handle = setTimer(() => {
					handle = undefined;
					const next = pending;
					pending = undefined;
					if (next !== undefined) {
						invoke(next.value);
					}
				}, intervalMs - elapsed);
			}
		},
		cancel(): void {
			if (handle !== undefined) {
				clearTimer(handle);
				handle = undefined;
			}
			pending = undefined;
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM 层（需要 F5 实测）
//
// 结构与几何都按 `token` 记忆化：几何坐标是相对内容容器顶部的，不随滚动变化，
// 因此滚动热路径只做两次 rect 读取 + 二分。面板在 `update` 与尺寸变化（ResizeObserver）
// 时换一个 token 让缓存失效。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个锚点块的结构信息（不含几何）。 */
export interface CodeLineElement {
	element: HTMLElement;
	/** 预览行号（`data-line`）。 */
	line: number;
	/** 该块最后一行；代码块由"下一个锚点行号 - 1"推出。 */
	endLine: number;
}

let cache: { container: ParentNode; token: unknown; entries: readonly CodeLineElement[] } | null = null;
let boundsCache: { container: HTMLElement; token: unknown; bounds: LineBounds[] } | null = null;

/**
 * 收集锚点元素（内置 `getCodeLineElements` 的等价实现）。
 *
 * - `<ul>`/`<ol>` 跳过（避免与首个子项重复）；
 * - 锚点落在 `<code>` 上（围栏代码块）时归到父 `<pre>`（`<pre>` 才有 padding 可扣）；
 * - 已经含有锚点 `<code>` 子元素的 `<pre>` 跳过（避免与 `<code>` 重复）；
 * - 同一行只保留文档顺序里第一个（= 最外层）锚点；
 * - 代码块的 `endLine` = 下一个锚点行号 - 1。
 */
export function collectCodeLineElements(container: ParentNode, token: unknown): readonly CodeLineElement[] {
	if (cache !== null && cache.container === container && cache.token === token) {
		return cache.entries;
	}

	const entries: CodeLineElement[] = [];
	for (const node of Array.from(container.querySelectorAll<HTMLElement>(anchorSelector()))) {
		const line = getLineForElement(node);
		if (line === null) {
			continue;
		}
		const element = normalizeAnchorElement(node);
		if (element === null) {
			continue;
		}
		const previous = entries[entries.length - 1];
		if (previous !== undefined && previous.line === line) {
			continue;
		}
		entries.push({ element, line, endLine: line });
	}

	entries.sort((a, b) => a.line - b.line);
	// 代码块的 endLine：下一个锚点的行号 - 1（文末哨兵保证最后一个代码块也有 next）。
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		const next = entries[i + 1];
		if (entry === undefined || next === undefined || next.line <= entry.line) {
			continue;
		}
		if (isCodeBlockElement(entry.element)) {
			entry.endLine = next.line - 1;
		}
	}

	cache = { container, token, entries };
	return entries;
}

/** 清空锚点结构/几何缓存（也可直接换一个 `token`）。 */
export function resetCodeLineCache(): void {
	cache = null;
	boundsCache = null;
}

/** `<ul>`/`<ol>`、以及重复的 `<pre>`/`<code>` 处理；返回 `null` 表示跳过该锚点。 */
function normalizeAnchorElement(node: HTMLElement): HTMLElement | null {
	const tag = node.tagName;
	if (tag === "UL" || tag === "OL") {
		return null;
	}
	// 围栏代码块：锚点在 <code> 上，几何要用父 <pre>（含 padding）。
	if (tag === "CODE" && node.parentElement !== null && node.parentElement.tagName === "PRE") {
		return node.parentElement;
	}
	// <pre> 自己带锚点、同时内部还有锚点 <code>：交给 <code> 那条路径，避免重复。
	if (tag === "PRE" && node.querySelector(anchorSelector()) !== null) {
		return null;
	}
	return node;
}

function isCodeBlockElement(element: HTMLElement): boolean {
	return element.tagName === "PRE" || element.tagName === "CODE";
}

/** 读取元素几何（相对内容容器顶部），并做嵌套收缩。 */
function readElementBounds(
	element: HTMLElement,
	originTop: number,
): { top: number; height: number; contentTop: number; contentHeight: number } {
	const rect = element.getBoundingClientRect();
	const style = window.getComputedStyle(element);
	const paddingTop = cssPixels(style.paddingTop);
	const paddingBottom = cssPixels(style.paddingBottom);
	const borderTop = cssPixels(style.borderTopWidth);
	const borderBottom = cssPixels(style.borderBottomWidth);

	// 嵌套收缩：含子锚点的元素只取到子元素上沿，避免外层块把锚点"拉长"。
	const child = firstChildAnchor(element);
	const bottom = child === null ? rect.bottom : child.getBoundingClientRect().top;

	return {
		top: rect.top - originTop,
		height: Math.max(0, bottom - rect.top),
		contentTop: rect.top + borderTop + paddingTop - originTop,
		contentHeight: Math.max(0, rect.height - borderTop - borderBottom - paddingTop - paddingBottom),
	};
}

function firstChildAnchor(element: HTMLElement): HTMLElement | null {
	return element.querySelector<HTMLElement>(anchorSelector());
}

function cssPixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 内置 `isVisible`：排除关闭的 `<details>`、`display:none`、`visibility:hidden` 与完全零尺寸。
 *
 * 注意：只把**宽高都为 0** 视为不可见——文末哨兵这类 `height: 0` 但宽度正常的锚点不能杀。
 */
export function isAnchorVisible(element: HTMLElement): boolean {
	if (element.closest("details:not([open])") !== null) {
		return false;
	}
	const style = window.getComputedStyle(element);
	if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
		return false;
	}
	const rect = element.getBoundingClientRect();
	return rect.width > 0 || rect.height > 0;
}

/** 把结构信息读成纯几何数组（过滤不可见锚点，坐标相对内容容器顶部）。需要 DOM。 */
export function readLineBounds(container: HTMLElement, entries: readonly CodeLineElement[]): LineBounds[] {
	const originTop = container.getBoundingClientRect().top;
	const bounds: LineBounds[] = [];
	for (const entry of entries) {
		if (!isAnchorVisible(entry.element)) {
			continue;
		}
		const geometry = readElementBounds(entry.element, originTop);
		bounds.push({
			line: entry.line,
			endLine: entry.endLine,
			top: geometry.top,
			height: geometry.height,
			contentTop: geometry.contentTop,
			contentHeight: geometry.contentHeight,
		});
	}
	return bounds;
}

/**
 * 带缓存的几何读取。
 *
 * 坐标是**相对内容容器顶部**的，因此不随滚动变化——滚动热路径上重复计算
 * （每个锚点一次 `getBoundingClientRect` + `getComputedStyle`）会非常贵，这里按
 * `token` 记忆化，面板在 `update` 与尺寸变化（ResizeObserver）时换 `token` 失效。
 */
export function collectLineBounds(container: HTMLElement, token: unknown): LineBounds[] {
	if (boundsCache !== null && boundsCache.container === container && boundsCache.token === token) {
		return boundsCache.bounds;
	}
	const bounds = readLineBounds(container, collectCodeLineElements(container, token));
	boundsCache = { container, token, bounds };
	return bounds;
}

/** 读取元素的预览行号；`data-line` 优先，兼容旧别名 `data-source-line`。 */
export function getLineForElement(element: Element | null): number | null {
	if (element === null) {
		return null;
	}
	for (const name of SOURCE_LINE_ATTRIBUTES) {
		const raw = element.getAttribute(name);
		if (raw === null) {
			continue;
		}
		const line = Number.parseFloat(raw);
		if (Number.isFinite(line) && line > 0) {
			return line;
		}
	}
	return null;
}

/** 从任意（含文本）节点沿祖先链找最近的锚点行号。 */
export function getLineForNode(node: Element | null): number | null {
	if (node === null) {
		return null;
	}
	return getLineForElement(node.closest(anchorSelector()));
}

/**
 * 内置的 `elementFromPoint` 回退：几何二分取不到锚点时才用
 * （例如可见锚点数组为空，或偏移落在所有锚点之外且没有插值结果）。
 */
function lineFromPoint(scroller: HTMLElement, offset: number): number | null {
	const rect = scroller.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		return null;
	}
	const x = rect.left + rect.width / 2;
	const y = Math.min(Math.max(rect.top + offset, rect.top), rect.bottom - 1);
	return getLineForNode(document.elementFromPoint(x, y));
}

/** 内容容器顶部在滚动容器坐标系里的位置（内容可能有 margin/padding）。 */
function contentOriginInScroller(scroller: HTMLElement, content: HTMLElement): number {
	return content.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * 预览滚动位置 → 预览行号。`viewportOffset` 是相对滚动容器顶部的偏移。
 * 返回整数预览行号；没有可用锚点时返回 `null`。
 */
export function getEditorLineNumberForPageOffset(
	scroller: HTMLElement,
	content: HTMLElement,
	viewportOffset: number,
	token: unknown,
): number | null {
	const bounds = collectLineBounds(content, token);
	const offset = scroller.scrollTop + viewportOffset - contentOriginInScroller(scroller, content);
	const line = lineForPageOffset(findLinePair(bounds, offset), offset);
	if (line === null) {
		return lineFromPoint(scroller, viewportOffset);
	}
	return Math.floor(line);
}

/**
 * 预览行号 → 滚动（内置 `scrollToRevealSourceLine`）。
 *
 * 返回 `false` 表示没有对应锚点，或目标已在 snap zone 内（不需要滚）。
 */
export function scrollToRevealLine(
	scroller: HTMLElement,
	content: HTMLElement,
	line: number,
	behavior: ScrollBehavior,
	token: unknown,
): boolean {
	const bounds = collectLineBounds(content, token);
	if (bounds.length === 0) {
		return false;
	}
	const target =
		contentOriginInScroller(scroller, content) + pageOffsetForLine(findBoundsForLine(bounds, line), line);
	const clamped = Math.max(MIN_SCROLL_TARGET, target);
	if (isWithinSnapZone(scroller.scrollTop, clamped, scroller.clientHeight)) {
		return false;
	}
	scroller.scrollTo({ top: clamped, behavior });
	return true;
}
