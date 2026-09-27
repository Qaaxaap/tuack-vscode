import { describe, expect, it } from "vitest";

import {
	isSafeUrl,
	sanitizeHtml,
	sanitizeHtmlWithReport,
} from "../../../features/preview/sanitize";

describe("sanitizeHtml：危险标签", () => {
	it("丢弃 <script> 及其内容", () => {
		const html = sanitizeHtml("<p>a</p><script>alert(1)</script><p>b</p>");
		expect(html).toBe("<p>a</p><p>b</p>");
	});

	it("大小写混写的 <SCRIPT> 同样丢弃", () => {
		const report = sanitizeHtmlWithReport("<SCRIPT>alert(1)</SCRIPT>");
		expect(report.html).toBe("");
		expect(report.removedTags).toContain("script");
	});

	it("丢弃 <style>/<iframe>/<object>/<svg> 及其内容", () => {
		const input = [
			"<style>body{background:url(javascript:alert(1))}</style>",
			'<iframe src="https://evil.example"></iframe>',
			"<object data=x></object>",
			"<svg><script>alert(1)</script></svg>",
		].join("");
		expect(sanitizeHtml(input)).toBe("");
	});

	it("未闭合的 script 也会吞掉到文档末尾", () => {
		expect(sanitizeHtml("<script>alert(1)")).toBe("");
	});

	it("丢弃注释（含条件注释里的脚本）", () => {
		expect(sanitizeHtml("a<!-- <script>alert(1)</script> -->b")).toBe("ab");
	});

	it("未知标签丢弃但保留子内容", () => {
		const report = sanitizeHtmlWithReport("<foo>bar<b>baz</b></foo>");
		expect(report.html).toBe("bar<b>baz</b>");
		expect(report.removedTags).toEqual(["foo", "foo"]);
	});
});

describe("sanitizeHtml：属性", () => {
	it("丢弃 on* 事件处理器", () => {
		const report = sanitizeHtmlWithReport('<img src="x.png" onerror="alert(1)">');
		expect(report.html).toBe('<img src="x.png">');
		expect(report.removedAttributes).toContain("onerror");
	});

	it("大小写混写的 OnErRoR 也被丢弃", () => {
		expect(sanitizeHtml('<img src="x.png" OnErRoR="alert(1)">')).toBe('<img src="x.png">');
	});

	it("丢弃 srcdoc / formaction / xlink:href 等白名单外属性", () => {
		const html = sanitizeHtml('<iframe srcdoc="<script>x</script>"></iframe><a href="#" xlink:href="javascript:x">y</a>');
		expect(html).toBe('<a href="#">y</a>');
	});

	it("保留 data-* 属性（data-line 依赖它）", () => {
		expect(sanitizeHtml('<p data-line="12">x</p>')).toBe('<p data-line="12">x</p>');
	});

	it("保留 class / lang，丢弃未列出的属性", () => {
		expect(sanitizeHtml('<code class="language-c++" lang="en" foo="1">x</code>')).toBe(
			'<code class="language-c++" lang="en">x</code>',
		);
	});

	it("style 只保留 text-align", () => {
		const html = sanitizeHtml(
			'<td style="text-align:right;background:url(javascript:alert(1));color:red">1</td>',
		);
		expect(html).toBe('<td style="text-align:right">1</td>');
	});

	it("style 全部非法时整个属性丢弃", () => {
		expect(sanitizeHtml('<td style="position:fixed">1</td>')).toBe("<td>1</td>");
	});

	it("已有的实体不会二次转义", () => {
		expect(sanitizeHtml('<img src="a&amp;b.png" alt="x">')).toBe('<img src="a&amp;b.png" alt="x">');
	});

	it("未加引号的属性值照常解析", () => {
		expect(sanitizeHtml("<img src=x.png alt=hi>")).toBe('<img src="x.png" alt="hi">');
	});
});

describe("sanitizeHtml：URL scheme", () => {
	it("挡掉 javascript: / vbscript: / data:text/html", () => {
		expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
		expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe("<a>x</a>");
		expect(sanitizeHtml('<img src="data:text/html,<script>alert(1)</script>">')).toBe("<img>");
	});

	it("挡掉经实体编码或空白拆分的 javascript:（浏览器会先解码）", () => {
		expect(sanitizeHtml('<a href="java&#x73;cript:alert(1)">x</a>')).toBe("<a>x</a>");
		expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
		expect(sanitizeHtml('<a href="java&colon;script:alert(1)">x</a>')).toBe("<a>x</a>");
		expect(sanitizeHtml('<a href="  JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
	});

	it("允许 http(s) / mailto / 相对路径 / data:image", () => {
		expect(sanitizeHtml('<a href="https://example.com/a?b=1&amp;c=2">x</a>')).toBe(
			'<a href="https://example.com/a?b=1&amp;c=2">x</a>',
		);
		expect(sanitizeHtml('<a href="mailto:a@b.c">x</a>')).toBe('<a href="mailto:a@b.c">x</a>');
		expect(sanitizeHtml('<a href="../statement.md#sec">x</a>')).toBe('<a href="../statement.md#sec">x</a>');
		expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(
			'<img src="data:image/png;base64,iVBORw0KGgo=">',
		);
	});

	it("blockedUrls 记录被拒绝的 URL", () => {
		const report = sanitizeHtmlWithReport('<a href="javascript:alert(1)">x</a>');
		expect(report.blockedUrls).toEqual(["javascript:alert(1)"]);
	});

	it("isSafeUrl 的 kind 语义：data:image 只在 src 上放行", () => {
		expect(isSafeUrl("data:image/png;base64,AAA", "src")).toBe(true);
		expect(isSafeUrl("data:image/png;base64,AAA", "href")).toBe(false);
		expect(isSafeUrl("data:text/html,<b>", "src")).toBe(false);
		expect(isSafeUrl("#fragment", "href")).toBe(true);
	});
});

describe("sanitizeHtml：健壮性", () => {
	it("畸形输入不抛错：裸 < 与未闭合标签退化为文本", () => {
		expect(sanitizeHtml("1 < 2 and 3 <4")).toBe("1 &lt; 2 and 3 &lt;4");
		expect(sanitizeHtml('a <img src="x.png"')).toBe('a &lt;img src="x.png"');
	});

	it("空字符串返回空字符串", () => {
		expect(sanitizeHtml("")).toBe("");
	});

	it("幂等：sanitize(sanitize(x)) === sanitize(x)", () => {
		const inputs = [
			'<p data-line="1">x</p>',
			'<img src="x.png" onerror="1">',
			'<table><tr data-line="3"><td style="text-align:left">a</td></tr></table>',
		];
		for (const input of inputs) {
			const once = sanitizeHtml(input);
			expect(sanitizeHtml(once)).toBe(once);
		}
	});

	it("markdown-it 表格输出可以原样通过", () => {
		const table =
			'<table>\n<thead>\n<tr data-line="1">\n<th style="text-align:left">a</th>\n</tr>\n</thead>\n</table>\n';
		expect(sanitizeHtml(table)).toBe(table);
	});
});
