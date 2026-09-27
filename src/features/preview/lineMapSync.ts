/**
 * 滚动同步的行映射索引。
 *
 * 数据来源有两份，职责不同：
 * 1. **协议 `lineMap`**（`RenPreviewResult.lineMap`，1 起）：`source` = `statement.md` 行号，
 *    `rendered` = MiniJinja 展开后的 Markdown 行号。
 *    ⚠️ 协议规定**同一 `source` 只记首次出现的 `rendered`**，因此 `{% for %}` 循环体
 *    的第 2..n 次展开在 `lineMap` 里**没有条目**，无法双向映射。
 * 2. **渲染侧锚点**（HTML 块级元素上的 `data-line="<渲染后行号>"`）：由 `render.ts` 写入，
 *    是预览里真正能定位到元素的行号集合。
 *
 * 因此本模块的策略是：**以渲染侧锚点为主，`lineMap` 用来换算 source ↔ rendered**；
 * 任何查不到精确映射的行都回退到最近的锚点（`before` / `after`），并如实告知调用方。
 *
 * **行号空间约定**：`data-line` 的值是「预览行号」= 渲染后 Markdown 的行号。
 * 扩展侧负责把编辑器行（`statement.md`）与预览行互相换算；webview 只按 `data-line` 定位，
 * 这样可以直接套用 VS Code 内置 Markdown 预览的选择器与查找逻辑。
 *
 * 纯函数，不依赖 VS Code API 与 DOM，可以在 vitest 里直接测，也能被 webview bundle 复用。
 */

import type { LineMapEntry } from "../../rpc/protocol";

/**
 * 预览锚点属性名。
 *
 * 与 VS Code 内置 Markdown 预览（`markdown-language-features/preview/scroll-sync.ts`）的
 * `data-line` 同名同义：值 = 该块级元素对应的 Markdown 行号（1 起）。
 * 因此内置的选择器（`[data-line]`）与查找逻辑可以直接复用到我们的预览上。
 */
export const SOURCE_LINE_ATTRIBUTE = "data-line";

/** 兼容别名：早期实现用的 `data-source-line`，`render.ts` 仍会一起写，避免下游改坏。 */
export const SOURCE_LINE_ATTRIBUTE_ALIAS = "data-source-line";

/** 所有可用的锚点属性名（`data-line` 优先）。 */
export const SOURCE_LINE_ATTRIBUTES: readonly string[] = [SOURCE_LINE_ATTRIBUTE, SOURCE_LINE_ATTRIBUTE_ALIAS];

/** 在 DOM 里查找锚点元素的 CSS 选择器（`data-line` 或兼容别名）。 */
export function anchorSelector(line?: number): string {
	if (line === undefined) {
		return SOURCE_LINE_ATTRIBUTES.map((name) => `[${name}]`).join(",");
	}
	return SOURCE_LINE_ATTRIBUTES.map((name) => `[${name}="${line}"]`).join(",");
}

/**
 * 命中方式：
 * - `exact`：源/渲染行有精确映射，且返回的行就是该映射；
 * - `before`：没有精确映射，回退到目标之前最近的锚点；
 * - `after`：目标之前没有任何锚点，只能回退到之后最近的锚点；
 * - `none`：输入非法，或没有任何映射/锚点可用。
 */
export type ResolutionKind = "exact" | "before" | "after" | "none";

export interface AnchorResolution {
	/** 1 起的目标行号；`kind === "none"` 时为 `null`。 */
	line: number | null;
	kind: ResolutionKind;
}

export interface LineMapIndex {
	/** 归一化后的 `source → rendered` 映射，按 `source` 升序、`source` 唯一。 */
	readonly pairs: readonly LineMapEntry[];
	/** 渲染侧可用锚点行号，升序、去重（调用方提供时以调用方为准）。 */
	readonly anchors: readonly number[];
	/** 编辑器（源）行 → 预览（渲染）行，带最近锚点回退。 */
	renderedForSource(source: number): AnchorResolution;
	/** 预览（渲染）行 → 编辑器（源）行，带最近锚点回退（循环体走这条路）。 */
	sourceForRendered(rendered: number): AnchorResolution;
}

const NONE: AnchorResolution = { line: null, kind: "none" };

/** 行号必须是正的整数（协议 1 起；0/负数/NaN/小数一律丢弃）。 */
function isValidLine(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** 第一个 `values[i] >= target` 的下标；空数组返回 `values.length`。 */
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
 * 建立双向查询索引。
 *
 * @param lineMap 协议返回的 `lineMap`（允许乱序、含重复 `source`；重复时保留 `rendered` 最小的一条，
 *                即"首次出现"）。
 * @param renderedAnchors 渲染侧锚点（HTML 里 `data-source-line` 的取值集合）。给了就以它为准；
 *                        省略（或全部非法）时退化为 `lineMap` 自带的 `rendered`。
 */
export function buildLineMapIndex(
	lineMap: readonly LineMapEntry[],
	renderedAnchors: readonly number[] = [],
): LineMapIndex {
	// ── 归一化 pairs：按 source 去重（保留最小 rendered = 首次出现）并排序 ──
	const bySource = new Map<number, number>();
	// 协议类型是编译期契约；运行时仍按不可信输入处理（RPC 响应来自另一个进程）。
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
	// 渲染侧锚点是"HTML 里真的存在 `data-source-line` 的行"这一权威集合；调用方给了就用它，
	// 不允许 lineMap 的 rendered 混进来（那些行可能是空行 / 模板标记，DOM 里没有元素）。
	// 只有调用方完全没给锚点时，才退化为 lineMap 的 rendered（至少让换算可用）。
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

	// ── 供 rendered → source 查询：按 rendered 升序（同一 rendered 保留最小 source） ──
	const byRendered = [...pairs].sort((a, b) => a.rendered - b.rendered || a.source - b.source);
	const renderedValues = byRendered.map((pair) => pair.rendered);

	/**
	 * 把 `ideal`（lineMap 换算出的渲染行）吸附到最近的渲染侧锚点。
	 * 优先取之前最近的锚点——滚动同步时"显示目标之前的内容"比"之后"更符合直觉。
	 */
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
				// 源行落在两个映射之间：回退到之前的映射（渲染行同样吸附到最近锚点）。
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
				// 循环体第 2..n 次展开：没有 lineMap 条目，回退到之前映射的源行。
				return { line: before.source, kind: "before" };
			}
			const after = byRendered[position];
			return after === undefined ? NONE : { line: after.source, kind: "after" };
		},
	};
}

