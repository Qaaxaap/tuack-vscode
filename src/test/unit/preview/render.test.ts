import { describe, expect, it } from "vitest";

import { renderMarkdown, renderMarkdownToHtml } from "../../../features/preview/render";

/** HTML 里出现过的全部 `data-line` 取值（含重复）。 */
function sourceLineAttributes(html: string): number[] {
	return [...html.matchAll(/data-line="(\d+)"/g)].map((match) => Number.parseInt(match[1] ?? "0", 10));
}

describe("renderMarkdown：data-line 锚点", () => {
	it("块级元素写入渲染后 Markdown 的行号（1 起）", () => {
		const result = renderMarkdown("intro\n\n## 标题\n\n- a\n- b\n");
		expect(result.html).toContain('<p data-line="1">intro</p>');
		expect(result.html).toContain('<h2 data-line="3">标题</h2>');
		expect(result.html).toContain('<li data-line="5">a</li>');
		expect(result.html).toContain('<li data-line="6">b</li>');
		// 末位是文末哨兵：行数 7 → data-line 8。
		expect(result.anchors).toEqual([1, 3, 5, 6, 8]);
	});

	it("锚点集合与 HTML 里实际出现的属性完全一致", () => {
		const result = renderMarkdown("# A\n\ntext\n\n```\ncode\n```\n");
		expect(new Set(sourceLineAttributes(result.html))).toEqual(new Set(result.anchors));
		expect(result.anchors).toEqual([1, 3, 5, 9]);
	});

	it("围栏代码块与缩进代码块也带锚点", () => {
		const fence = renderMarkdown("```c++\nint main() {}\n```\n");
		expect(fence.html).toContain("<pre>");
		expect(fence.html).toContain("language-c++");
		expect(fence.html).toContain('data-line="1"');
		expect(fence.anchors).toEqual([1, 5]);

		const indented = renderMarkdown("    plain code\n");
		expect(indented.html).toContain('<pre data-line="1">');
	});

	it("表格：表头与表体行分别锚定到各自行号，对齐样式保留", () => {
		const result = renderMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |\n");
		expect(result.html).toContain('<table data-line="1">');
		expect(result.html).toContain('style="text-align:left"');
		expect(result.html).toContain('style="text-align:right"');
		expect(result.html).toContain('<tr data-line="1">');
		expect(result.html).toContain('<tr data-line="3">');
		expect(result.anchors).toEqual([1, 3, 5]);
	});

	it("表格对齐同时写 data-align（DOMPurify 可能丢掉 style 时的兜底）", () => {
		const result = renderMarkdown("| a | b | c |\n|:--|--:|:-:|\n| 1 | 2 | 3 |\n");
		expect(result.html).toContain('data-align="left"');
		expect(result.html).toContain('data-align="right"');
		expect(result.html).toContain('data-align="center"');
	});

	it("锚点属性用内置预览同名的 data-line，不再写旧别名", () => {
		const result = renderMarkdown("x\n");
		expect(result.html).toContain('<p data-line="1">x</p>');
		expect(result.html).not.toContain("data-source-line");
	});

	it("正文末尾追加文末哨兵（指向 行数 + 1）", () => {
		// "a\n\nb" 共 3 行 → 哨兵 data-line = 4（与内置 markdownDocument.lineCount + 1 同义）。
		const result = renderMarkdown("a\n\nb");
		expect(result.html).toContain('<div class="code-line" data-line="4"></div>');
		expect(result.anchors.at(-1)).toBe(4);

		// 末尾带换行时行数按 split 计（最后一行是空行），哨兵仍严格大于所有真实锚点。
		const withTrailing = renderMarkdown("a\n\nb\n");
		const sentinel = withTrailing.anchors.at(-1) ?? 0;
		expect(sentinel).toBe(5);
		expect(sentinel).toBeGreaterThan(Math.max(...withTrailing.anchors.slice(0, -1)));
	});

	it("空文档不追加哨兵（HTML 保持为空）", () => {
		const result = renderMarkdown("");
		expect(result.html).toBe("");
		expect(result.anchors).toEqual([]);
	});

	it("sourceLines: false 时不写入锚点", () => {
		const result = renderMarkdown("para\n", { sourceLines: false });
		expect(result.html).not.toContain("data-line");
		expect(result.anchors).toEqual([]);
	});
});

describe("renderMarkdown：安全", () => {
	it("html: false：原始 HTML 被转义为文本", () => {
		const result = renderMarkdown("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n");
		expect(result.html).not.toContain("<script");
		expect(result.html).toContain("&lt;script&gt;");
		expect(result.html).not.toContain("<img src=x");
		expect(result.removedTags).toEqual([]);
		expect(result.blockedUrls).toEqual([]);
	});

	it("image 的 src 保留相对路径（改写由扩展侧做）", () => {
		const result = renderMarkdown("![示例](images/sample.png)\n");
		expect(result.html).toContain('<img src="images/sample.png" alt="示例">');
	});

	it("javascript: 链接不会变成可点击的 href", () => {
		// markdown-it 的 validateLink 会把 javascript: 链接退化成纯文本；
		// 即便它漏出来，消毒器也会把 href 整个丢掉（第二道防线）。
		const result = renderMarkdown('[x](javascript:alert(1))\n');
		expect(result.html).not.toContain('href="javascript');
		expect(result.html).not.toContain("<a ");
	});
});

describe("renderMarkdown：健壮性", () => {
	it("空文档不崩，输出空字符串", () => {
		const result = renderMarkdown("");
		expect(result.html).toBe("");
		expect(result.anchors).toEqual([]);
	});

	it("只有空白的文档不崩", () => {
		expect(() => renderMarkdown("\n\n   \n\t\n")).not.toThrow();
	});

	it("未闭合的围栏代码块不崩", () => {
		const result = renderMarkdown("```python\nprint(1)\n");
		expect(result.html).toContain("<pre>");
		expect(result.html).toContain("print(1)");
		expect(result.anchors.length).toBe(2); // 围栏锚点 + 文末哨兵
	});

	it("超长表格（400 行 × 8 列）不崩且完整渲染", () => {
		const columns = 8;
		const header = `| ${Array.from({ length: columns }, (_, i) => `h${i}`).join(" | ")} |`;
		const separator = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
		const rows = Array.from(
			{ length: 400 },
			(_, row) => `| ${Array.from({ length: columns }, (_, col) => `${row}-${col}`).join(" | ")} |`,
		);
		const result = renderMarkdown([header, separator, ...rows].join("\n"));
		expect(result.html).toContain("<table");
		expect((result.html.match(/<tr /g) ?? []).length).toBe(401);
		expect(result.html).toContain("399-7");
		expect(result.anchors.length).toBe(402); // 401 个真实锚点 + 文末哨兵
	});

	it("超深嵌套与畸形输入不崩", () => {
		expect(() => renderMarkdown(`${"> ".repeat(200)}x`)).not.toThrow();
		expect(() => renderMarkdown(`${"- ".repeat(200)}x`)).not.toThrow();
		expect(() => renderMarkdown("| a |\n|---|\n| ")).not.toThrow();
		expect(() => renderMarkdown("~~~js\nlet a = 1;\n~~~\n")).not.toThrow();
		expect(() => renderMarkdown("text with \u0000 null byte and \u{1f600} emoji")).not.toThrow();
	});

	it("renderMarkdownToHtml 与 renderMarkdown().html 一致", () => {
		const markdown = "## t\n\n> quote\n";
		expect(renderMarkdownToHtml(markdown)).toBe(renderMarkdown(markdown).html);
	});

	it("重复渲染同一输入结果稳定（渲染器可复用）", () => {
		const first = renderMarkdown("a\n\nb\n");
		const second = renderMarkdown("a\n\nb\n");
		expect(second).toEqual(first);
	});
});
