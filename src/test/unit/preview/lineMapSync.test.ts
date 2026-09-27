import { describe, expect, it } from "vitest";

import type { LineMapEntry } from "../../../rpc/protocol";
import {
	SOURCE_LINE_ATTRIBUTE,
	SOURCE_LINE_ATTRIBUTE_ALIAS,
	anchorSelector,
	buildLineMapIndex,
} from "../../../features/preview/lineMapSync";

/** 协议里的循环展开：`source` 5..7 展开成 rendered 8..14，但只记第一次出现。 */
const LOOP_LINE_MAP: LineMapEntry[] = [
	{ source: 1, rendered: 1 },
	{ source: 5, rendered: 8 },
];

describe("buildLineMapIndex：归一化", () => {
	it("乱序输入按 source 排序", () => {
		const index = buildLineMapIndex([
			{ source: 9, rendered: 20 },
			{ source: 2, rendered: 3 },
		]);
		expect(index.pairs).toEqual([
			{ source: 2, rendered: 3 },
			{ source: 9, rendered: 20 },
		]);
		expect(index.anchors).toEqual([3, 20]);
	});

	it("同一 source 重复出现时保留最小的 rendered（协议：只记首次出现）", () => {
		const index = buildLineMapIndex([
			{ source: 5, rendered: 10 },
			{ source: 5, rendered: 8 },
		]);
		expect(index.pairs).toEqual([{ source: 5, rendered: 8 }]);
	});

	it("非法行号（0 / 负数 / 小数 / NaN）被丢弃", () => {
		const dirty = [
			{ source: 0, rendered: 1 },
			{ source: -2, rendered: 3 },
			{ source: 4, rendered: 0 },
			{ source: 2.5, rendered: 6 },
			{ source: Number.NaN, rendered: 7 },
			null,
			"nope",
		] as unknown as LineMapEntry[];
		const index = buildLineMapIndex(dirty);
		expect(index.pairs).toEqual([]);
		expect(index.anchors).toEqual([]);
		expect(index.renderedForSource(1)).toEqual({ line: null, kind: "none" });
	});

	it("渲染侧锚点去重排序；给了锚点就以它为准（lineMap 的 rendered 不混入）", () => {
		const index = buildLineMapIndex(LOOP_LINE_MAP, [12, 1, 12, 8, 0]);
		expect(index.anchors).toEqual([1, 8, 12]);

		// 没给锚点时才退化为 lineMap 的 rendered。
		const withoutExplicitAnchors = buildLineMapIndex(LOOP_LINE_MAP, []);
		expect(withoutExplicitAnchors.anchors).toEqual([1, 8]);

		// 传了锚点但 lineMap 的 rendered 不在其中：lineMap 的行不会被当成锚点。
		const subset = buildLineMapIndex(LOOP_LINE_MAP, [1, 12]);
		expect(subset.anchors).toEqual([1, 12]);
	});

	it("空输入返回空索引", () => {
		const index = buildLineMapIndex([]);
		expect(index.pairs).toEqual([]);
		expect(index.anchors).toEqual([]);
		expect(index.sourceForRendered(1)).toEqual({ line: null, kind: "none" });
	});
});

describe("renderedForSource：编辑器行换算预览行", () => {
	const index = buildLineMapIndex(LOOP_LINE_MAP, [1, 8, 12, 20]);

	it("精确命中", () => {
		expect(index.renderedForSource(1)).toEqual({ line: 1, kind: "exact" });
		expect(index.renderedForSource(5)).toEqual({ line: 8, kind: "exact" });
	});

	it("源行落在两个映射之间：回退到之前最近的映射", () => {
		expect(index.renderedForSource(3)).toEqual({ line: 1, kind: "before" });
		expect(index.renderedForSource(4)).toEqual({ line: 1, kind: "before" });
	});

	it("源行超过最后一个映射：回退到最后一个映射", () => {
		expect(index.renderedForSource(99)).toEqual({ line: 8, kind: "before" });
	});

	it("源行早于第一个映射且没有更早的锚点：回退到之后最近的锚点", () => {
		const single = buildLineMapIndex([{ source: 5, rendered: 8 }], [8]);
		expect(single.renderedForSource(2)).toEqual({ line: 8, kind: "after" });
	});

	it("映射行不是渲染侧锚点时吸附到之前最近的锚点", () => {
		const snapped = buildLineMapIndex(LOOP_LINE_MAP, [1, 20]);
		expect(snapped.renderedForSource(5)).toEqual({ line: 1, kind: "before" });
	});

	it("没有锚点时只做 lineMap 换算", () => {
		const plain = buildLineMapIndex(LOOP_LINE_MAP, []);
		expect(plain.renderedForSource(5)).toEqual({ line: 8, kind: "exact" });
	});

	it("非法输入返回 none", () => {
		expect(index.renderedForSource(0)).toEqual({ line: null, kind: "none" });
		expect(index.renderedForSource(Number.NaN)).toEqual({ line: null, kind: "none" });
	});
});

describe("sourceForRendered：预览行换算编辑器行（含循环体 fallback）", () => {
	const index = buildLineMapIndex(LOOP_LINE_MAP, [1, 8, 12, 20]);

	it("精确命中", () => {
		expect(index.sourceForRendered(1)).toEqual({ line: 1, kind: "exact" });
		expect(index.sourceForRendered(8)).toEqual({ line: 5, kind: "exact" });
	});

	it("{% for %} 循环体第 2..n 次展开没有映射：回退到之前映射的源行", () => {
		// rendered 12 / 20 都是循环体后续展开，lineMap 里没有条目。
		expect(index.sourceForRendered(12)).toEqual({ line: 5, kind: "before" });
		expect(index.sourceForRendered(20)).toEqual({ line: 5, kind: "before" });
	});

	it("落在两个映射之间：取之前的映射", () => {
		expect(index.sourceForRendered(4)).toEqual({ line: 1, kind: "before" });
	});

	it("早于第一个映射：取之后的映射", () => {
		const shifted = buildLineMapIndex([{ source: 4, rendered: 8 }], [8]);
		expect(shifted.sourceForRendered(1)).toEqual({ line: 4, kind: "after" });
	});

	it("非法输入返回 none", () => {
		expect(index.sourceForRendered(0)).toEqual({ line: null, kind: "none" });
		expect(index.sourceForRendered(2.5)).toEqual({ line: null, kind: "none" });
	});
});

describe("锚点属性约定：与内置 Markdown 预览对齐", () => {
	it("主属性名 data-line 与内置同名，旧别名只读不写", () => {
		expect(SOURCE_LINE_ATTRIBUTE).toBe("data-line");
		expect(SOURCE_LINE_ATTRIBUTE_ALIAS).toBe("data-source-line");
	});

	it("anchorSelector 同时匹配主属性与别名", () => {
		expect(anchorSelector()).toBe("[data-line],[data-source-line]");
		expect(anchorSelector(12)).toBe('[data-line="12"],[data-source-line="12"]');
	});
});
