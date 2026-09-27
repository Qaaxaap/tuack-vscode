/**
 * 轻量白名单 HTML 消毒器。
 *
 * 定位：**纵深防御**。预览的主渲染器（`render.ts`）已经用 `markdown-it` 的
 * `html: false` 关掉了原始 HTML，因此正常链路上不会有攻击面；但
 * - 未来的渲染引擎（`tuack.preview.engine = vscode-markdown`）会原样透传 HTML；
 * - 题面里可能出现 `</p><script>` 之类的边界输入；
 * - 前端 `innerHTML` 之前再过一遍，成本极低。
 *
 * 设计约束：
 * - **零依赖、纯函数**（可以被 vitest 直接测，也能被 webview bundle 复用）。
 * - 白名单而非黑名单：只保留明确列出的标签/属性；`on*` 事件处理器、
 *   未知属性、命名空间属性一律丢弃。
 * - URL：只允许无 scheme 的相对路径与本文件列出的 scheme；
 *   `javascript:` / `vbscript:` / `data:text/html` 一类全部拒绝。
 * - 不抛错：任何畸形输入（未闭合标签、裸 `<`、注释未闭合）都退化为转义文本。
 *
 * 注意：本模块**不是**通用 sanitizer（如 DOMPurify）的替代品。它只处理
 * 「渲染器自己产出的 HTML + 一点点不可信文本」这个场景。
 */

/** 允许出现的标签（都必须是"无副作用"的排版标签）。 */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
	"a",
	"abbr",
	"b",
	"blockquote",
	"br",
	"caption",
	"cite",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
	"details",
	"dfn",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"ins",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"pre",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"small",
	"span",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"time",
	"tr",
	"u",
	"ul",
	"var",
	"wbr",
]);

/**
 * 这些标签**连同内容**一起丢弃。
 *
 * 前一批是可执行/可加载外部资源的内容（原始文本元素，浏览器不会解析其中的标签）；
 * 后一批是虽不执行脚本、但留在文档里没有意义甚至有害的元数据标签。
 */
const STRIP_CONTENT_TAGS: ReadonlySet<string> = new Set([
	"applet",
	"base",
	"canvas",
	"embed",
	"frame",
	"frameset",
	"iframe",
	"link",
	"math",
	"meta",
	"noembed",
	"noframes",
	"noscript",
	"object",
	"plaintext",
	"script",
	"style",
	"svg",
	"template",
	"textarea",
	"title",
	"xmp",
]);

/** HTML void 元素：不需要（也不应该）输出结束标签。 */
const VOID_TAGS: ReadonlySet<string> = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

/** 所有标签都允许的属性（`data-*` 另行按需放行）。 */
const GLOBAL_ATTRIBUTES: readonly string[] = ["class", "dir", "lang", "title"];

/** 逐标签的额外属性白名单。 */
const TAG_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
	a: ["href", "rel", "target"],
	img: ["alt", "decoding", "height", "loading", "src", "width"],
	li: ["value"],
	ol: ["reversed", "start", "type"],
	td: ["align", "colspan", "headers", "rowspan", "scope", "style", "valign"],
	th: ["align", "colspan", "headers", "rowspan", "scope", "style", "valign"],
	table: ["border", "cellpadding", "cellspacing", "summary"],
	time: ["datetime"],
};

/** 需要做 URL 校验的属性；未列出的属性按普通文本处理。 */
const URL_ATTRIBUTES: ReadonlyMap<string, UrlKind> = new Map<string, UrlKind>([
	["href", "href"],
	["cite", "href"],
	["src", "src"],
]);

/** URL 的性质：链接（可 mailto 等）还是资源（可 data:image）。 */
type UrlKind = "href" | "src";

/** `href` 允许的 scheme（无 scheme 的相对路径另行放行）。 */
const HREF_SCHEMES: ReadonlySet<string> = new Set([
	"http",
	"https",
	"mailto",
	"tel",
	// webview 资源 URI：扩展侧改写图片后可能出现，保留以兼容 vscode-markdown 引擎。
	"vscode-cdn",
	"vscode-resource",
	"vscode-webview-resource",
]);

/** `src` 允许的 scheme。 */
const SRC_SCHEMES: ReadonlySet<string> = new Set([
	"http",
	"https",
	"blob",
	"vscode-cdn",
	"vscode-resource",
	"vscode-webview-resource",
]);

/** `data:` 只允许这几种图片 MIME（`data:text/html` 这类必须拒绝）。 */
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]*$/i;

/**
 * `style` 只允许这几个属性。markdown-it 的表格对齐会输出
 * `style="text-align:left"`，是我们唯一需要保留的样式。
 */
const SAFE_STYLE_PROPERTIES: ReadonlySet<string> = new Set(["text-align"]);
const SAFE_STYLE_VALUES = /^(?:left|right|center|justify|start|end)$/i;

/** 允许出现的无值属性（HTML 布尔属性）。 */
const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set(["reversed"]);

export interface SanitizeOptions {
	/** 在默认白名单之外额外允许的标签（小写）。 */
	extraTags?: readonly string[];
	/** 是否允许 `data-*` 属性（默认 `true`；`data-source-line` 依赖它）。 */
	allowDataAttributes?: boolean;
}

export interface SanitizeReport {
	html: string;
	/** 被丢弃的标签名（小写，按出现顺序，可重复）。 */
	removedTags: string[];
	/** 被丢弃的属性名（小写，按出现顺序，可重复）。 */
	removedAttributes: string[];
	/** 被拒绝的 URL 原值。 */
	blockedUrls: string[];
}

/** 判断 URL 是否可以保留。`kind` 决定允许的 scheme 集合。 */
export function isSafeUrl(raw: string, kind: UrlKind): boolean {
	// 浏览器在解析 URL 前会先做实体解码、并忽略 scheme 内部的空白与控制字符，
	// 因此这里也必须先归一化，否则 `java&#x73;cript:` / `java\tscript:` 会绕过检查。
	const normalized = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, "");
	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(normalized);
	if (!schemeMatch) {
		// 相对路径、锚点、协议相对 URL（`//host/...` 按 http(s) 处理）。
		return true;
	}
	const scheme = (schemeMatch[1] ?? "").toLowerCase();
	if (kind === "src" && scheme === "data") {
		return DATA_IMAGE_PATTERN.test(normalized);
	}
	return kind === "src" ? SRC_SCHEMES.has(scheme) : HREF_SCHEMES.has(scheme);
}

/** 便捷包装：只要消毒后的 HTML。 */
export function sanitizeHtml(input: string, options?: SanitizeOptions): string {
	return sanitizeHtmlWithReport(input, options).html;
}

/**
 * 消毒并返回统计信息。
 *
 * 幂等：`sanitize(sanitize(x)) === sanitize(x)`（除统计字段外）。
 */
export function sanitizeHtmlWithReport(input: string, options: SanitizeOptions = {}): SanitizeReport {
	const report: SanitizeReport = {
		html: "",
		removedTags: [],
		removedAttributes: [],
		blockedUrls: [],
	};
	if (input.length === 0) {
		return report;
	}

	const extraTags = new Set((options.extraTags ?? []).map((tag) => tag.toLowerCase()));
	const allowDataAttributes = options.allowDataAttributes ?? true;
	const out: string[] = [];
	let index = 0;

	while (index < input.length) {
		const lt = input.indexOf("<", index);
		if (lt < 0) {
			out.push(input.slice(index));
			break;
		}
		if (lt > index) {
			out.push(input.slice(index, lt));
		}

		// 注释 / doctype / CDATA / 处理指令：整段丢弃（注释里可能藏条件注释脚本）。
		if (input.startsWith("<!--", lt)) {
			const end = input.indexOf("-->", lt + 4);
			if (end < 0) break;
			index = end + 3;
			continue;
		}
		if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
			const end = input.indexOf(">", lt + 2);
			if (end < 0) break;
			index = end + 1;
			continue;
		}

		const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)/.exec(input.slice(lt));
		if (!match) {
			// 裸 `<`（例如 `1 < 2`）：转义后原样输出。
			out.push("&lt;");
			index = lt + 1;
			continue;
		}

		const closing = match[1] === "/";
		const name = (match[2] ?? "").toLowerCase();
		const attrStart = lt + match[0].length;
		const tagEnd = findTagEnd(input, attrStart);
		if (tagEnd < 0) {
			// 未闭合的标签：按文本处理，避免吞掉后续内容。
			out.push("&lt;");
			index = lt + 1;
			continue;
		}
		const attrText = input.slice(attrStart, tagEnd);
		index = tagEnd + 1;

		if (!ALLOWED_TAGS.has(name) && !extraTags.has(name)) {
			report.removedTags.push(name);
			if (!closing && STRIP_CONTENT_TAGS.has(name) && !VOID_TAGS.has(name)) {
				index = skipToClosingTag(input, name, index);
			}
			continue;
		}

		if (closing) {
			if (!VOID_TAGS.has(name)) {
				out.push(`</${name}>`);
			}
			continue;
		}

		const attributes = filterAttributes(name, attrText, report, allowDataAttributes);
		out.push(renderOpenTag(name, attributes));
	}

	report.html = out.join("").replace(/\u0000/g, "");
	return report;
}

/** 从 `from` 起找到不在引号内的 `>`；找不到返回 -1。 */
function findTagEnd(input: string, from: number): number {
	let quote: string | null = null;
	for (let i = from; i < input.length; i += 1) {
		const char = input[i];
		if (quote !== null) {
			if (char === quote) {
				quote = null;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") {
			return i;
		}
	}
	return -1;
}

/** 跳过 `</name ...>` 之后的位置；没有结束标签时返回字符串末尾。 */
function skipToClosingTag(input: string, name: string, from: number): number {
	const lower = input.toLowerCase();
	const closing = lower.indexOf(`</${name}`, from);
	if (closing < 0) {
		return input.length;
	}
	const gt = input.indexOf(">", closing);
	return gt < 0 ? input.length : gt + 1;
}

/** 解析并过滤属性；返回 `[name, value]` 列表。 */
function filterAttributes(
	tag: string,
	text: string,
	report: SanitizeReport,
	allowDataAttributes: boolean,
): Array<[string, string]> {
	const allowed = new Set<string>([...GLOBAL_ATTRIBUTES, ...(TAG_ATTRIBUTES[tag] ?? [])]);
	const result: Array<[string, string]> = [];
	const attributePattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let match: RegExpExecArray | null;

	while ((match = attributePattern.exec(text)) !== null) {
		const rawName = match[1] ?? "";
		const name = rawName.toLowerCase();
		const value = match[2] ?? match[3] ?? match[4] ?? null;
		const reject = (): void => {
			report.removedAttributes.push(name);
		};

		// 事件处理器：白名单本来就挡住了，这里显式记录以便观测。
		if (name.startsWith("on")) {
			reject();
			continue;
		}
		// 命名空间属性（`xlink:href` 等）可能绕过普通 URL 检查，一律丢弃。
		if (name.includes(":")) {
			reject();
			continue;
		}
		const isDataAttribute = allowDataAttributes && name.startsWith("data-");
		if (!allowed.has(name) && !isDataAttribute) {
			reject();
			continue;
		}

		if (value === null) {
			if (BOOLEAN_ATTRIBUTES.has(name)) {
				result.push([name, ""]);
			} else {
				reject();
			}
			continue;
		}

		const urlKind = URL_ATTRIBUTES.get(name);
		if (urlKind !== undefined) {
			if (!isSafeUrl(value, urlKind)) {
				report.blockedUrls.push(value);
				continue;
			}
		}

		if (name === "style") {
			const safeStyle = sanitizeStyleValue(value);
			if (safeStyle === null) {
				reject();
				continue;
			}
			result.push([name, safeStyle]);
			continue;
		}

		result.push([name, value]);
	}

	return result;
}

/** 只保留 `text-align` 一类的安全声明；没有可用声明时返回 `null`。 */
function sanitizeStyleValue(value: string): string | null {
	const kept: string[] = [];
	for (const declaration of value.split(";")) {
		const separator = declaration.indexOf(":");
		if (separator < 0) {
			continue;
		}
		const property = declaration.slice(0, separator).trim().toLowerCase();
		const propertyValue = declaration.slice(separator + 1).trim();
		if (!SAFE_STYLE_PROPERTIES.has(property)) {
			continue;
		}
		if (!SAFE_STYLE_VALUES.test(propertyValue)) {
			continue;
		}
		kept.push(`${property}:${propertyValue.toLowerCase()}`);
	}
	return kept.length > 0 ? kept.join(";") : null;
}

function renderOpenTag(name: string, attributes: readonly (readonly [string, string])[]): string {
	const rendered = attributes.map(([attrName, attrValue]) => ` ${attrName}="${escapeAttribute(attrValue)}"`).join("");
	return `<${name}${rendered}>`;
}

/** 转义属性值；已经成形的实体不再二次转义（避免 `&amp;` 变成 `&amp;amp;`）。 */
function escapeAttribute(value: string): string {
	return value
		.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	apos: "'",
	colon: ":",
	commat: "@",
	gt: ">",
	lpar: "(",
	lt: "<",
	newline: "\n",
	num: "#",
	period: ".",
	quest: "?",
	quot: '"',
	rpar: ")",
	sol: "/",
	tab: "\t",
};

/** 解码常见实体（用于 URL scheme 判定，不影响输出）。 */
function decodeEntities(value: string): string {
	return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body.startsWith("#")) {
			const isHex = body[1] === "x" || body[1] === "X";
			const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : whole;
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
	});
}

function safeFromCodePoint(code: number): string {
	try {
		return String.fromCodePoint(code);
	} catch {
		return "";
	}
}
