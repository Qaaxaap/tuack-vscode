/**
 * 题面预览的 Markdown 渲染器（**纯函数**，不依赖 VS Code API）。
 *
 * 链路：`ren/preview` → `{ markdown, lineMap }` → `renderMarkdown(markdown)` → `{ html, anchors }`。
 * 渲染器自 bundle `markdown-it`（不用 `markdown.api.render`）的理由见设计 §4.5：
 * 后者图片必 404、无 KaTeX CSS、输出随用户设置漂移，且是内部命令。
 *
 * 关键行为：
 * - `html: false`：原始 HTML 不渲染，按文本转义输出（tuack 的题面检查本身就在警告 HTML 用法）。
 * - 每个块级元素写 `data-line="<渲染后 Markdown 的行号>"`（1 起，来自 `token.map`），
 *   与 VS Code 内置 Markdown 预览的锚点属性同名同义，前端可直接套用内置的查找逻辑。
 *   （早期实现用的 `data-source-line` 仍被前端选择器兼容读取，但不再写出。）
 * - 渲染结果再过一遍 `sanitize.ts`（Node 侧的白名单预过滤，纵深防御）。
 *   webview 侧还会用 DOMPurify 再过一遍（浏览器内的权威防线）。
 */

import MarkdownIt from "markdown-it";

import { SOURCE_LINE_ATTRIBUTE } from "./lineMapSync";
import { sanitizeHtmlWithReport } from "./sanitize";

export interface RenderOptions {
	/** 是否写入 `data-line` 锚点（默认 `true`）。关掉后 `anchors` 为空。 */
	sourceLines?: boolean;
	/** 渲染后是否消毒（默认 `true`）。关闭仅用于调试/对照测试。 */
	sanitize?: boolean;
}

export interface RenderResult {
	/** 消毒后的 HTML 片段。 */
	html: string;
	/** HTML 里实际出现的锚点行号（`data-line` 取值），升序去重。 */
	anchors: number[];
	/** 被消毒器丢弃的标签（正常情况下为空）。 */
	removedTags: string[];
	/** 被消毒器丢弃的属性（正常情况下为空）。 */
	removedAttributes: string[];
	/** 被消毒器拒绝的 URL（正常情况下为空）。 */
	blockedUrls: string[];
}

/**
 * 这些 token 不写 `data-line`：
 * - `inline` / `text` 不是独立元素，属性不会被渲染；
 * - `html_block` / `html_inline` 在 `html: false` 下不会出现，列出来只是保持意图明确。
 */
const SKIP_TOKEN_TYPES: ReadonlySet<string> = new Set(["inline", "text", "html_block", "html_inline"]);

/**
 * 单例渲染器。`markdown-it` 实例不持有每次渲染的状态（`env` 按调用传入），
 * 因此可以安全复用；`default` preset 自带 GFM 表格与删除线。
 */
const markdownIt = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: false,
	breaks: false,
});

/** 从最终 HTML 反查锚点，保证 `anchors` 与 DOM 里能查到的完全一致。 */
function collectAnchors(html: string): number[] {
	const anchors = new Set<number>();
	const pattern = new RegExp(`${SOURCE_LINE_ATTRIBUTE}="(\\d+)"`, "g");
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		const line = Number.parseInt(match[1] ?? "", 10);
		if (Number.isFinite(line) && line > 0) {
			anchors.add(line);
		}
	}
	return [...anchors].sort((a, b) => a - b);
}

/** 给块级 token 写入锚点属性（`data-line`，与内置预览同名）。 */
function injectSourceLines(tokens: readonly MarkdownIt.Token[]): void {
	for (const token of tokens) {
		if (token.map === null || token.nesting === -1) {
			continue;
		}
		if (SKIP_TOKEN_TYPES.has(token.type)) {
			continue;
		}
		const startLine = token.map[0];
		if (!Number.isInteger(startLine) || startLine < 0) {
			continue;
		}
		token.attrSet(SOURCE_LINE_ATTRIBUTE, String(startLine + 1));
	}
}

const ALIGNMENT_PATTERN = /text-align\s*:\s*(left|right|center|justify)/i;

/**
 * 把 markdown-it 表格对齐输出的 `style="text-align:…"` 复制一份成 `data-align`。
 *
 * 原因：webview 侧的 DOMPurify 可能（按版本/配置）丢掉 `style` 属性，对齐靠
 * `media/preview.css` 里的 `[data-align]` 规则兜底，保证表格排版不漂。
 */
function injectTableAlignment(tokens: readonly MarkdownIt.Token[]): void {
	for (const token of tokens) {
		const style = token.attrGet("style");
		if (style === null) {
			continue;
		}
		const alignment = ALIGNMENT_PATTERN.exec(style)?.[1]?.toLowerCase();
		if (alignment !== undefined) {
			token.attrSet("data-align", alignment);
		}
	}
}

/**
 * 把展开后的 Markdown 渲染成 HTML。
 *
 * 不抛错：任何输入（空文档、未闭合代码块、超长表格、畸形嵌套）都退化为合法 HTML 片段。
 */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): RenderResult {
	const source = typeof markdown === "string" ? markdown : String(markdown ?? "");
	const withSourceLines = options.sourceLines ?? true;
	const withSanitize = options.sanitize ?? true;

	// `parse` + `renderer.render` 而不是 `render()`：需要在渲染前注入 token 属性。
	const env: Record<string, unknown> = {};
	const tokens = markdownIt.parse(source, env);
	injectTableAlignment(tokens);
	if (withSourceLines) {
		injectSourceLines(tokens);
	}
	const raw = markdownIt.renderer.render(tokens, markdownIt.options, env);

	if (!withSanitize) {
		return { html: raw, anchors: collectAnchors(raw), removedTags: [], removedAttributes: [], blockedUrls: [] };
	}
	const report = sanitizeHtmlWithReport(raw);
	return {
		html: report.html,
		anchors: collectAnchors(report.html),
		removedTags: report.removedTags,
		removedAttributes: report.removedAttributes,
		blockedUrls: report.blockedUrls,
	};
}

/** 只要 HTML 的便捷包装。 */
export function renderMarkdownToHtml(markdown: string, options?: RenderOptions): string {
	return renderMarkdown(markdown, options).html;
}
