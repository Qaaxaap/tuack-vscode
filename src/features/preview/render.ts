/**
 * 题面预览的 Markdown 渲染器，纯函数，不依赖 VS Code API。
 *
 * 自 bundle markdown-it（markdown.api.render 图片必 404，输出还随用户设置漂移）。
 * 块级元素写 1 起的 data-line（渲染后 Markdown 行号），属性名跟内置 Markdown 预览一致。
 * html:false 挡原始 HTML，渲染后再过一遍 sanitize.ts；正文末尾补哨兵锚点，否则最后一个块滚不到底。
 */

import MarkdownIt from "markdown-it";

import { SOURCE_LINE_ATTRIBUTE } from "./lineMapSync";
import { sanitizeHtmlWithReport } from "./sanitize";

export interface RenderOptions {
	/** 是否写 data-line 锚点，默认 true；关掉后 anchors 为空。 */
	sourceLines?: boolean;
	/** 渲染后是否消毒，默认 true；关掉只用于调试。 */
	sanitize?: boolean;
}

export interface RenderResult {
	/** 消毒后的 HTML 片段。 */
	html: string;
	/** HTML 里出现过的锚点行号，升序去重。 */
	anchors: number[];
	/** 被消毒器丢弃的标签，正常为空。 */
	removedTags: string[];
	/** 被消毒器丢弃的属性，正常为空。 */
	removedAttributes: string[];
	/** 被消毒器拒绝的 URL，正常为空。 */
	blockedUrls: string[];
}

/** 不写 data-line 的 token：inline/text 不是独立元素，html_* 在 html:false 下不会出现。 */
const SKIP_TOKEN_TYPES: ReadonlySet<string> = new Set(["inline", "text", "html_block", "html_inline"]);

/** 复用同一个实例：env 按调用传入，实例不带每次渲染的状态。default preset 自带 GFM 表格。 */
const markdownIt = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: false,
	breaks: false,
});

/** 从最终 HTML 反查锚点，保证和 DOM 里能查到的集合一致。 */
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

/** 给块级 token 写 data-line。 */
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

/** 表格对齐另写一份 data-align：DOMPurify 可能丢掉 style，CSS 里按属性兜底。 */
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

/** 文末哨兵的 class，跟内置预览一致。 */
const SENTINEL_CLASS = "code-line";

/** Markdown 行数，与 data-line 同一套 1 起基准。 */
function countLines(markdown: string): number {
	if (markdown.length === 0) {
		return 0;
	}
	return markdown.split(/\r\n|\r|\n/).length;
}

// 末尾补一个指向「行数 + 1」的空锚点，内置 documentRenderer 也这么做。
function appendEndSentinel(html: string, markdown: string): string {
	return `${html}<div class="${SENTINEL_CLASS}" data-line="${countLines(markdown) + 1}"></div>`;
}

/** 渲染展开后的 Markdown。空文档、未闭合代码块、畸形嵌套都退化成合法 HTML，不抛错。 */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): RenderResult {
	const source = typeof markdown === "string" ? markdown : String(markdown ?? "");
	const withSourceLines = options.sourceLines ?? true;
	const withSanitize = options.sanitize ?? true;

	// 用 parse + renderer.render，注入 token 属性后再渲染。
	const env: Record<string, unknown> = {};
	const tokens = markdownIt.parse(source, env);
	injectTableAlignment(tokens);
	if (withSourceLines) {
		injectSourceLines(tokens);
	}
	let raw = markdownIt.renderer.render(tokens, markdownIt.options, env);
	if (withSourceLines && raw.trim().length > 0) {
		raw = appendEndSentinel(raw, source);
	}

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
