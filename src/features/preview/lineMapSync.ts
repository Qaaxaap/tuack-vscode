/**
 * 编辑器行 ↔ 预览行的换算，供滚动同步用。纯函数，不依赖 VS Code API 与 DOM。
 *
 * lineMap 同一 source 只记首次出现的 rendered，循环体第 2..n 次展开因此查不到，这里回退到最近锚点。
 * 行号空间：data-line 的值是预览行号，编辑器行到预览行的换算在扩展侧做，webview 只按 data-line 定位。
 */

import type { LineMapEntry } from "../../rpc/protocol";

/** 锚点属性名，跟 VS Code 内置 Markdown 预览的 data-line 同名同义，值是该块的 Markdown 行号（1 起）。 */
export const SOURCE_LINE_ATTRIBUTE = "data-line";

/** 早期实现用的属性名，选择器仍然读它。 */
export const SOURCE_LINE_ATTRIBUTE_ALIAS = "data-source-line";

/** 可用的锚点属性名，data-line 优先。 */
export const SOURCE_LINE_ATTRIBUTES: readonly string[] = [SOURCE_LINE_ATTRIBUTE, SOURCE_LINE_ATTRIBUTE_ALIAS];

/** 查锚点元素的 CSS 选择器；带 line 时限定行号。 */
export function anchorSelector(line?: number): string {
	if (line === undefined) {
		return SOURCE_LINE_ATTRIBUTES.map((name) => `[${name}]`).join(",");
	}
	return SOURCE_LINE_ATTRIBUTES.map((name) => `[${name}="${line}"]`).join(",");
}

/** 命中方式：exact 精确映射；before/after 回退到最近锚点；none 没有可用映射。 */
export type ResolutionKind = "exact" | "before" | "after" | "none";

export interface AnchorResolution {
	/** 1 起的目标行号，kind 为 none 时是 null。 */
	line: number | null;
	kind: ResolutionKind;
}

export interface LineMapIndex {
	/** source 到 rendered 的映射，按 source 升序且唯一。 */
	readonly pairs: readonly LineMapEntry[];
	/** 预览里可用锚点行号，升序去重；调用方提供了锚点就以它为准。 */
	readonly anchors: readonly number[];
	/** 编辑器行到预览行。 */
	renderedForSource(source: number): AnchorResolution;
	/** 预览行到编辑器行，循环体走这条回退。 */
	sourceForRendered(rendered: number): AnchorResolution;
}

const NONE: AnchorResolution = { line: null, kind: "none" };

/** 只接受正整数行号（协议 1 起）。 */
function isValidLine(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 第一个 values[i] >= target 的下标；找不到返回 values.length。 */
function lowerBound(values: readonly number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		const value = values[mid];
		if (value !== undefined && value < target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

/**
 * lineMap 允许乱序和重复 source（重复时保留最小的 rendered）。renderedAnchors 是 HTML 里
 * 真正存在的锚点行，给了就以它为准；完全不传时退化成 lineMap 的 rendered。
 */
export function buildLineMapIndex(
	lineMap: readonly LineMapEntry[],
	renderedAnchors: readonly number[] = [],
): LineMapIndex {
	// ── 归一化 pairs：按 source 去重（保留最小 rendered，即首次出现）并排序 ──
	const bySource = new Map<number, number>();
	// RPC 响应来自另一个进程，运行时仍按不可信输入过滤。
	for (const raw of lineMap as readonly unknown[]) {
		if (raw === null || typeof raw !== "object") {
			continue;
		}
		const { source, rendered } = raw as Partial<LineMapEntry>;
		if (!isValidLine(source) || !isValidLine(rendered)) {
			continue;
		}
		const existing = bySource.get(source);
		if (existing === undefined || rendered < existing) {
			bySource.set(source, rendered);
		}
	}
	const pairs: LineMapEntry[] = [...bySource.entries()]
		.map(([source, rendered]) => ({ source, rendered }))
		.sort((a, b) => a.source - b.source);
	const sources = pairs.map((pair) => pair.source);

	// ── 归一化 anchors ──
	// 调用方给了锚点就以它为准：lineMap 的 rendered 可能是空行或模板标记，DOM 里没有对应元素。
	const explicitAnchors = renderedAnchors.filter(isValidLine);
	const anchorSet = new Set<number>();
	if (explicitAnchors.length > 0) {
		for (const anchor of explicitAnchors) {
			anchorSet.add(anchor);
		}
	} else {
		for (const pair of pairs) {
			anchorSet.add(pair.rendered);
		}
	}
	const anchors = [...anchorSet].sort((a, b) => a - b);

	// ── rendered 到 source 查询用：按 rendered 升序，同一 rendered 保留最小 source ──
	const byRendered = [...pairs].sort((a, b) => a.rendered - b.rendered || a.source - b.source);
	const renderedValues = byRendered.map((pair) => pair.rendered);

	/** 把换算出的渲染行吸附到最近锚点；优先取之前的，显示目标之前的内容更符合直觉。 */
	function snapToAnchor(ideal: number, mappedKind: ResolutionKind): AnchorResolution {
		if (anchors.length === 0) {
			return { line: ideal, kind: mappedKind };
		}
		const position = lowerBound(anchors, ideal);
		if (anchors[position] === ideal) {
			return { line: ideal, kind: mappedKind };
		}
		const before = position > 0 ? anchors[position - 1] : undefined;
		if (before !== undefined) {
			return { line: before, kind: "before" };
		}
		const after = anchors[position];
		return after === undefined ? { line: ideal, kind: mappedKind } : { line: after, kind: "after" };
	}

	return {
		pairs,
		anchors,

		renderedForSource(source: number): AnchorResolution {
			if (!isValidLine(source)) {
				return NONE;
			}
			if (pairs.length === 0) {
				return NONE;
			}
			const position = lowerBound(sources, source);
			const exact = pairs[position];
			if (exact !== undefined && exact.source === source) {
				return snapToAnchor(exact.rendered, "exact");
			}
			const before = position > 0 ? pairs[position - 1] : undefined;
			if (before !== undefined) {
				// 源行落在两个映射之间：回退到之前的映射。
				return snapToAnchor(before.rendered, "before");
			}
			const after = pairs[position];
			return after === undefined ? NONE : snapToAnchor(after.rendered, "after");
		},

		sourceForRendered(rendered: number): AnchorResolution {
			if (!isValidLine(rendered)) {
				return NONE;
			}
			if (byRendered.length === 0) {
				return NONE;
			}
			const position = lowerBound(renderedValues, rendered);
			const exact = byRendered[position];
			if (exact !== undefined && exact.rendered === rendered) {
				return { line: exact.source, kind: "exact" };
			}
			const before = position > 0 ? byRendered[position - 1] : undefined;
			if (before !== undefined) {
				// 循环体第 2..n 次展开没有 lineMap 条目，回退到之前映射的源行。
				return { line: before.source, kind: "before" };
			}
			const after = byRendered[position];
			return after === undefined ? NONE : { line: after.source, kind: "after" };
		},
	};
}

