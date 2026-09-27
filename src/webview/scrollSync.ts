/**
 * 预览面板侧的滚动定位。
 *
 * 这里**不是**自研算法，而是复刻 VS Code 内置 Markdown 预览
 * （`markdown-language-features/src/preview/scroll-sync.ts`）的做法：
 *
 * - 锚点属性同为 `data-line`（值 = 该块级元素对应的 Markdown 行号），选择器/查找逻辑可直接套用；
 * - 反查视口位置 → 行号用 `document.elementFromPoint` 拿到该点上的元素，
 *   再沿祖先链找最近的 `[data-line]`；拿不到时回退到按元素中点扫描的
 *   `getLineElementsAtPageOffset`（与内置同名函数等价）；
 * - 正向滚动（行号 → 位置）用 `data-line` 选择器定位元素后滚动到它的顶部。
 *
 * 行号空间全部是「预览行号」（`data-line` 的值）。编辑器行 ↔ 预览行的换算在扩展侧
 * 用 `buildLineMapIndex()` 完成，webview 不做映射。
 *
 * 待办：Lead 正在核实内置 `scroll-sync.ts` 的确切参数（例如锁定时长、定位偏移）。
 * 结论到达后只需调整本文件的常量/细节，消息协议形状不受影响。
 */

import { SOURCE_LINE_ATTRIBUTES, anchorSelector } from "../features/preview/lineMapSync";

/** 与内置预览一致：滚动到目标元素时在其上方留出的少量空隙（像素）。 */
export const SCROLL_REVEAL_MARGIN = 8;

/** 收集预览内容里全部锚点元素（文档顺序）。 */
export function getLineElements(container: ParentNode): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(anchorSelector()));
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
		const line = Number.parseInt(raw, 10);
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
 * 内置做法：`document.elementFromPoint` 取视口某点上的元素。
 *
 * `offset` 相对 `container` 顶部；返回 `null` 表示该点在视口外或没取到元素。
 */
export function getElementForPageOffset(container: HTMLElement, offset: number): Element | null {
	const rect = container.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		return null;
	}
	const x = rect.left + rect.width / 2;
	const y = Math.min(Math.max(rect.top + offset, rect.top), rect.bottom - 1);
	return document.elementFromPoint(x, y);
}

/** 内置同名函数：`offset` 处上下相邻的两个锚点元素（按元素中点判断）。 */
export function getLineElementsAtPageOffset(
	container: HTMLElement,
	offset: number,
): { previous: HTMLElement; next: HTMLElement } | undefined {
	const lines = getLineElements(container);
	const first = lines[0];
	if (first === undefined) {
		return undefined;
	}
	const position = container.getBoundingClientRect().top + offset;
	let previous = first;
	for (const line of lines) {
		const rect = line.getBoundingClientRect();
		if (rect.top + rect.height / 2 > position) {
			return { previous, next: line };
		}
		previous = line;
	}
	return { previous, next: previous };
}

/**
 * 视口位置 → 预览行号。
 *
 * 先按内置做法用 `elementFromPoint` 反查；取不到锚点时退回元素中点扫描的结果。
 */
export function getLineNumberForPageOffset(container: HTMLElement, offset: number): number | null {
	const fromPoint = getLineForNode(getElementForPageOffset(container, offset));
	if (fromPoint !== null) {
		return fromPoint;
	}
	const pair = getLineElementsAtPageOffset(container, offset);
	if (pair === undefined) {
		return null;
	}
	// 取 `next`（第一个中点仍在该位置下方的锚点），与内置 `getEditorLineNumberForPageOffset` 一致。
	return getLineForElement(pair.next) ?? getLineForElement(pair.previous);
}

/** 找到某个预览行对应的第一个锚点元素（循环体可能重复，取首次出现）。 */
export function findLineElement(container: ParentNode, line: number): HTMLElement | null {
	return container.querySelector<HTMLElement>(anchorSelector(line));
}

/**
 * 行号 → 滚动：把该预览行的锚点元素滚到可视区顶部。
 * 返回 `false` 表示该行在预览里没有对应元素（例如被消毒掉的空行）。
 */
export function scrollToRevealLine(
	scroller: HTMLElement,
	container: ParentNode,
	line: number,
	behavior: ScrollBehavior = "auto",
): boolean {
	const element = findLineElement(container, line);
	if (element === null) {
		return false;
	}
	const scrollerRect = scroller.getBoundingClientRect();
	const offset = element.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop;
	scroller.scrollTo({ top: Math.max(0, offset - SCROLL_REVEAL_MARGIN), behavior });
	return true;
}
