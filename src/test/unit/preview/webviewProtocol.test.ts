import { describe, expect, it } from "vitest";

import {
	PREVIEW_VIEW_TYPE,
	isHostToPreviewMessage,
	isPreviewToHostMessage,
	normalizeWarnings,
	resolveAssetUri,
} from "../../../webview/protocol";

describe("常量与行号约定", () => {
	it("viewType 与 package.json 的 activationEvents 一致", () => {
		expect(PREVIEW_VIEW_TYPE).toBe("tuack.preview");
	});

	// 滚动锁定/节流的时长断言在 scrollSync.test.ts（常量与算法同处一地，
	// 避免在协议模块里重复定义后两边漂移）。
});

describe("resolveAssetUri：图片 URI 改写", () => {
	it("扩展侧显式映射优先", () => {
		expect(resolveAssetUri("images/a.png", { "images/a.png": "https://webview/a.png" })).toBe(
			"https://webview/a.png",
		);
	});

	it("已经是绝对安全 URL 时原样保留", () => {
		expect(resolveAssetUri("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
		expect(resolveAssetUri("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	it("相对路径按 baseUri 解析", () => {
		expect(resolveAssetUri("a.png", undefined, "https://host/dir/statement.md")).toBe("https://host/dir/a.png");
	});

	it("危险 scheme 一律拒绝", () => {
		expect(resolveAssetUri("javascript:alert(1)")).toBeNull();
		expect(resolveAssetUri("data:text/html,<script>alert(1)</script>")).toBeNull();
	});

	it("既无映射也无 baseUri 的相对路径返回 null（前端应移除 src）", () => {
		expect(resolveAssetUri("images/a.png")).toBeNull();
		expect(resolveAssetUri("")).toBeNull();
	});

	it("前后空白会被去掉", () => {
		expect(resolveAssetUri("  https://cdn.example/a.png  ")).toBe("https://cdn.example/a.png");
	});
});

describe("消息校验：扩展 → 预览", () => {
	const updateMessage = {
		type: "update",
		html: '<p data-line="1">x</p>',
		generation: 3,
	};

	it("接受合法的 update / scrollToLine / status", () => {
		expect(isHostToPreviewMessage(updateMessage)).toBe(true);
		expect(isHostToPreviewMessage({ ...updateMessage, scrollToLine: 12, assets: { "a.png": "https://x" } })).toBe(
			true,
		);
		expect(isHostToPreviewMessage({ type: "scrollToLine", line: 12, behavior: "smooth" })).toBe(true);
		expect(isHostToPreviewMessage({ type: "status", state: "error", message: "boom" })).toBe(true);
	});

	it("拒绝缺字段或类型不对的消息", () => {
		expect(isHostToPreviewMessage(null)).toBe(false);
		expect(isHostToPreviewMessage("update")).toBe(false);
		expect(isHostToPreviewMessage({ type: "update", html: "" })).toBe(false);
		expect(isHostToPreviewMessage({ ...updateMessage, generation: "3" })).toBe(false);
		expect(isHostToPreviewMessage({ type: "scrollToLine", line: "12" })).toBe(false);
		expect(isHostToPreviewMessage({ type: "scrollToLine", line: Number.NaN })).toBe(false);
		expect(isHostToPreviewMessage({ type: "status", state: "huh" })).toBe(false);
		expect(isHostToPreviewMessage({ type: "render", html: "", lineMap: [], generation: 1 })).toBe(false);
	});
});

describe("消息校验：预览 → 扩展", () => {
	it("接受前端会发出的全部消息", () => {
		expect(isPreviewToHostMessage({ type: "ready" })).toBe(true);
		expect(isPreviewToHostMessage({ type: "requestUpdate", reason: "visible" })).toBe(true);
		expect(isPreviewToHostMessage({ type: "scroll", line: 5 })).toBe(true);
		expect(isPreviewToHostMessage({ type: "scroll", line: null })).toBe(true);
		expect(isPreviewToHostMessage({ type: "openLink", href: "https://x", line: 3 })).toBe(true);
		expect(isPreviewToHostMessage({ type: "openLink", href: "#sec", line: null })).toBe(true);
		expect(isPreviewToHostMessage({ type: "openImage", src: "x.png", originalSrc: null, line: 2 })).toBe(true);
		expect(isPreviewToHostMessage({ type: "log", level: "warn", message: "m" })).toBe(true);
	});

	it("拒绝形状不对的消息（webview 属不可信输入）", () => {
		expect(isPreviewToHostMessage(null)).toBe(false);
		expect(isPreviewToHostMessage({ type: "requestUpdate", reason: "whenever" })).toBe(false);
		expect(isPreviewToHostMessage({ type: "scroll" })).toBe(false);
		expect(isPreviewToHostMessage({ type: "scroll", line: "3" })).toBe(false);
		expect(isPreviewToHostMessage({ type: "openLink" })).toBe(false);
		expect(isPreviewToHostMessage({ type: "openImage", src: 42 })).toBe(false);
		expect(isPreviewToHostMessage({ type: "log", message: 1 })).toBe(false);
		expect(isPreviewToHostMessage({ type: "update", html: "x", generation: 1 })).toBe(false);
	});
});

describe("normalizeWarnings", () => {
	it("过滤空白、截断超长、限制条数", () => {
		expect(normalizeWarnings([" a ", "", "   ", "b"])).toEqual([" a ", "b"]);
		expect(normalizeWarnings(["x".repeat(600)])[0]?.length).toBe(500);
		expect(normalizeWarnings(["1", "2", "3"], 2)).toEqual(["1", "2"]);
		expect(normalizeWarnings([])).toEqual([]);
	});
});
