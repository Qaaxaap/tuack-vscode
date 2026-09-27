/**
 * 预览控制器单测。
 *
 * 这里**不 mock `vscode` 模块**（vitest 里根本没有它）：控制器只依赖
 * `PreviewEnvironment` / `PreviewHostFactory` / `PreviewRpc` 三个注入接口，
 * 测试用假实现注入，把「真正需要 VS Code 的部分」隔离在 `panel.ts`。
 *
 * 锁住的行为（都是本项目最容易踩的坑）：
 * - `ren/preview` 只读磁盘 → `tuack.preview.saveBeforePreview` 决定是否先保存；
 * - `scope` 必须精确到 `<day>/<problem>`（从 conf.json 向上找，不猜路径）；
 * - 不传 `template` 时零 assets/templates 依赖；配了才传；
 * - `ren/preview` 是同步 handler → **in-flight 单飞 + 尾随合并**；
 * - `conf.json` 变化 → 先 `config/reload` 再 preview；
 * - 面板消息必须过 `isPreviewToHostMessage`；行号在扩展侧做双向换算；
 * - `SCROLL_LOCK_MS`（旧 100ms）已由 `scrollSync.ts` 的 `HOST_SCROLL_LOCK_MS`（200ms）
 *   与 `SCROLL_THROTTLE_MS`（50ms）取代：锁定期内忽略编辑器可见行回声，其后按 URI 节流合并。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	PreviewController,
	resolvePreviewTarget,
	type PreviewDisposable,
	type PreviewEnvironment,
	type PreviewHost,
	type PreviewHostContext,
	type PreviewHostFactory,
	type PreviewRpc,
	type PreviewSettings,
	type TextDocumentLike,
	type UriLike,
} from "../../../features/preview/controller";
import { type HostToPreviewMessage } from "../../../webview/protocol";
import { HOST_SCROLL_LOCK_MS, SCROLL_THROTTLE_MS } from "../../../webview/scrollSync";
import type { RpcCallOptions } from "../../../rpc/client";
import type { MethodName, MethodParams, MethodResult } from "../../../rpc/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// 测试替身
// ─────────────────────────────────────────────────────────────────────────────

class FakeUri implements UriLike {
	constructor(readonly fsPath: string) {}
	toString(): string {
		return `file://${this.fsPath}`;
	}
}

/** 原样返回字符串的 URI（模拟 `asWebviewUri` 的 `vscode-webview://…` 结果）。 */
function literalUri(value: string): UriLike {
	return { fsPath: value, toString: () => value };
}

const disposable = (): PreviewDisposable => ({ dispose: () => undefined });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = async (times = 3): Promise<void> => {
	for (let index = 0; index < times; index += 1) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
};

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface RecordedCall {
	method: string;
	params: Record<string, unknown>;
	options: unknown;
}

class FakeRpc implements PreviewRpc {
	readonly opened: string[] = [];
	readonly calls: RecordedCall[] = [];
	handler: (method: string, params: Record<string, unknown>) => unknown = (method) => {
		if (method === "ren/preview") {
			return { markdown: "# Title\n\nbody\n", warnings: [], lineMap: [] };
		}
		return {};
	};

	controlSessionId(): string {
		return "session-1";
	}

	async openWorkspace(contestRootFsPath: string): Promise<void> {
		this.opened.push(contestRootFsPath);
	}

	async call<M extends MethodName>(
		method: M,
		params: MethodParams<M>,
		options?: RpcCallOptions,
	): Promise<MethodResult<M>> {
		this.calls.push({ method, params: (params ?? {}) as Record<string, unknown>, options });
		const result = this.handler(method, (params ?? {}) as Record<string, unknown>);
		return (await result) as MethodResult<M>;
	}

	callsOf(method: string): RecordedCall[] {
		return this.calls.filter((call) => call.method === method);
	}
}

class FakeWebview {
	readonly messages: HostToPreviewMessage[] = [];
	onMessage: ((message: unknown) => void) | undefined;

	postMessage(message: HostToPreviewMessage): Promise<boolean> {
		this.messages.push(message);
		return Promise.resolve(true);
	}

	asWebviewUri(uri: UriLike): UriLike {
		return literalUri(`vscode-webview://${uri.fsPath}`);
	}

	onDidReceiveMessage(handler: (message: unknown) => void): PreviewDisposable {
		this.onMessage = handler;
		return disposable();
	}
}

class FakeHost implements PreviewHost {
	readonly webview = new FakeWebview();
	readonly contexts: PreviewHostContext[] = [];
	readonly disposeHandlers = new Set<() => void>();
	visible = true;
	revealCount = 0;
	disposeCount = 0;

	constructor(public context: PreviewHostContext) {}

	reveal(): void {
		this.revealCount += 1;
	}

	update(context: PreviewHostContext): void {
		this.context = context;
		this.contexts.push(context);
	}

	onDidDispose(handler: () => void): PreviewDisposable {
		this.disposeHandlers.add(handler);
		return { dispose: () => this.disposeHandlers.delete(handler) };
	}

	dispose(): void {
		this.disposeCount += 1;
		for (const handler of [...this.disposeHandlers]) {
			handler();
		}
	}

	receive(message: unknown): void {
		this.webview.onMessage?.(message);
	}

	messagesOfType(type: HostToPreviewMessage["type"]): HostToPreviewMessage[] {
		return this.webview.messages.filter((message) => message.type === type);
	}
}

class FakeHostFactory implements PreviewHostFactory {
	readonly created: FakeHost[] = [];
	readonly beside: boolean[] = [];

	create(options: PreviewHostContext & { beside: boolean }): PreviewHost {
		this.beside.push(options.beside);
		const host = new FakeHost(options);
		this.created.push(host);
		return host;
	}

	get host(): FakeHost {
		const last = this.created[this.created.length - 1];
		if (last === undefined) {
			throw new Error("no host created yet");
		}
		return last;
	}
}

class FakeEnv implements PreviewEnvironment {
	settings: PreviewSettings = { debounceMs: 300, saveBeforePreview: true, defaultTemplate: null };
	activeDoc: TextDocumentLike | undefined;
	activeTop: number | undefined = 1;
	nowValue = 1_000;

	readonly saved: string[] = [];
	readonly revealed: { path: string; line: number }[] = [];
	readonly openedExternal: string[] = [];
	readonly openedResources: string[] = [];
	readonly warnings: string[] = [];
	readonly informations: string[] = [];
	readonly logs: { level: string; message: string }[] = [];
	statusBar: { text: string | undefined; tooltip: string | undefined } = { text: undefined, tooltip: undefined };

	private readonly changeHandlers = new Set<(document: TextDocumentLike) => void>();
	private readonly saveHandlers = new Set<(document: TextDocumentLike) => void>();
	private readonly configHandlers = new Set<(affects: (section: string) => boolean) => void>();
	private readonly visibleHandlers = new Set<(uri: UriLike, topLine: number) => void>();

	activeDocument(): TextDocumentLike | undefined {
		return this.activeDoc;
	}

	activeEditorTopLine(): number | undefined {
		return this.activeTop;
	}

	readSettings(): PreviewSettings {
		return this.settings;
	}

	onDidChangeTextDocument(handler: (document: TextDocumentLike) => void): PreviewDisposable {
		this.changeHandlers.add(handler);
		return { dispose: () => this.changeHandlers.delete(handler) };
	}

	onDidSaveTextDocument(handler: (document: TextDocumentLike) => void): PreviewDisposable {
		this.saveHandlers.add(handler);
		return { dispose: () => this.saveHandlers.delete(handler) };
	}

	onDidChangeConfiguration(handler: (affects: (section: string) => boolean) => void): PreviewDisposable {
		this.configHandlers.add(handler);
		return { dispose: () => this.configHandlers.delete(handler) };
	}

	onDidChangeEditorVisibleRange(handler: (uri: UriLike, topLine: number) => void): PreviewDisposable {
		this.visibleHandlers.add(handler);
		return { dispose: () => this.visibleHandlers.delete(handler) };
	}

	async save(uri: UriLike): Promise<boolean> {
		this.saved.push(uri.fsPath);
		return true;
	}

	async revealEditorLine(uri: UriLike, line: number): Promise<void> {
		this.revealed.push({ path: uri.fsPath, line });
	}

	async openExternal(href: string): Promise<boolean> {
		this.openedExternal.push(href);
		return true;
	}

	async openResource(uri: UriLike): Promise<void> {
		this.openedResources.push(uri.fsPath);
	}

	showWarning(message: string): void {
		this.warnings.push(message);
	}

	showInformation(message: string): void {
		this.informations.push(message);
	}

	fileUri(fsPath: string): UriLike {
		return new FakeUri(fsPath);
	}

	setStatusBar(text: string | undefined, tooltip?: string): void {
		this.statusBar = { text, tooltip };
	}

	translate(message: string, ...args: Array<string | number>): string {
		return message.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? ""));
	}

	log(level: string, message: string): void {
		this.logs.push({ level, message });
	}

	now(): number {
		return this.nowValue;
	}

	fireChange(document: TextDocumentLike): void {
		for (const handler of [...this.changeHandlers]) {
			handler(document);
		}
	}

	fireSave(document: TextDocumentLike): void {
		for (const handler of [...this.saveHandlers]) {
			handler(document);
		}
	}

	fireConfig(section: string): void {
		for (const handler of [...this.configHandlers]) {
			handler((candidate) => candidate === section);
		}
	}

	fireVisibleRange(uri: UriLike, topLine: number): void {
		for (const handler of [...this.visibleHandlers]) {
			handler(uri, topLine);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：一个最小的 Tuack 工程
// ─────────────────────────────────────────────────────────────────────────────

interface Fixture {
	root: string;
	contestRoot: string;
	statementPath: string;
	statementDir: string;
	dayConf: string;
	problemConf: string;
}

let fixture: Fixture;
let tempRoot: string;

function writeJson(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

beforeEach(() => {
	tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tuack-preview-"));
	fixture = {
		root: tempRoot,
		contestRoot: path.join(tempRoot, "contest"),
		statementPath: path.join(tempRoot, "contest", "day1", "p1", "statement.md"),
		statementDir: path.join(tempRoot, "contest", "day1", "p1"),
		dayConf: path.join(tempRoot, "contest", "day1", "conf.json"),
		problemConf: path.join(tempRoot, "contest", "day1", "p1", "conf.json"),
	};
	writeJson(path.join(fixture.contestRoot, "conf.json"), { folder: "contest", name: "contest" });
	writeJson(fixture.dayConf, { folder: "day", name: "day1" });
	writeJson(fixture.problemConf, { folder: "problem", name: "p1" });
	fs.writeFileSync(fixture.statementPath, "# Title\n", "utf8");
});

afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeDocument(filePath = fixture.statementPath, isDirty = true): TextDocumentLike {
	return { uri: new FakeUri(filePath), isDirty, languageId: "markdown" };
}

function makeHarness(): { controller: PreviewController; rpc: FakeRpc; env: FakeEnv; hosts: FakeHostFactory } {
	const rpc = new FakeRpc();
	const env = new FakeEnv();
	const hosts = new FakeHostFactory();
	const controller = new PreviewController({ rpc, env, hosts });
	return { controller, rpc, env, hosts };
}

// ─────────────────────────────────────────────────────────────────────────────
// 题目定位
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePreviewTarget", () => {
	it("从 statement.md 向上找 conf.json，得到精确的 <day>/<problem> scope", () => {
		const target = resolvePreviewTarget(fixture.statementPath);
		expect(target).toBeDefined();
		expect(target?.contestRoot).toBe(fixture.contestRoot);
		expect(target?.day).toBe("day1");
		expect(target?.problem).toBe("p1");
		expect(target?.scope).toBe("day1/p1");
	});

	it("scope 段按 JSON Pointer 规则转义（~ 与 /）", () => {
		const day = path.join(tempRoot, "d~1");
		const problem = path.join(day, "p~2");
		writeJson(path.join(tempRoot, "conf.json"), { folder: "contest", name: "c" });
		writeJson(path.join(day, "conf.json"), { folder: "day", name: "d~1" });
		writeJson(path.join(problem, "conf.json"), { folder: "problem", name: "p~2" });
		const statement = path.join(problem, "statement.md");
		fs.writeFileSync(statement, "# x\n", "utf8");

		const target = resolvePreviewTarget(statement);
		expect(target?.scope).toBe("d~01/p~02");
	});

	it("不在竞赛工程内时返回 undefined（不猜路径）", () => {
		const loose = path.join(tempRoot, "loose", "statement.md");
		fs.mkdirSync(path.dirname(loose), { recursive: true });
		fs.writeFileSync(loose, "# x\n", "utf8");
		expect(resolvePreviewTarget(loose)).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// show / 拉取 / 消息
// ─────────────────────────────────────────────────────────────────────────────

describe("PreviewController.show", () => {
	it("打开面板并推送全量 update（scope 精确、无 template、baseUri 指向题面目录）", async () => {
		const { controller, rpc, hosts } = makeHarness();
		rpc.handler = () => ({
			markdown: "# Title\n\nbody\n",
			warnings: ["模板里用了未定义的变量"],
			lineMap: [{ source: 1, rendered: 1 }],
		});

		const opened = await controller.show(makeDocument(), { beside: true });
		expect(opened).toBe(true);

		expect(hosts.created).toHaveLength(1);
		expect(hosts.beside).toEqual([true]);

		// 先 openWorkspace（惰性 spawn P1），再 ren/preview。
		expect(rpc.opened).toEqual([fixture.contestRoot]);
		const previews = rpc.callsOf("ren/preview");
		expect(previews).toHaveLength(1);
		expect(previews[0]?.params["scope"]).toBe("day1/p1");
		expect("template" in (previews[0]?.params ?? {})).toBe(false);

		const host = hosts.host;
		expect(host.messagesOfType("status")[0]).toMatchObject({ state: "loading" });

		const updates = host.messagesOfType("update");
		expect(updates).toHaveLength(1);
		const update = updates[0];
		if (update?.type !== "update") {
			throw new Error("expected an update message");
		}
		expect(update.generation).toBe(1);
		expect(update.html).toContain("<h1");
		expect(update.baseUri).toBe(`vscode-webview://${fixture.statementDir}`);

		const statuses = host.messagesOfType("status");
		expect(statuses[statuses.length - 1]).toMatchObject({
			state: "ready",
			warnings: ["模板里用了未定义的变量"],
		});
		controller.dispose();
	});

	it("只有配了 tuack.preview.defaultTemplate 才传 template（默认零 assets/templates 依赖）", async () => {
		const { controller, rpc, env } = makeHarness();
		env.settings.defaultTemplate = "default_manifest";
		await controller.show(makeDocument(), { beside: false });
		expect(rpc.callsOf("ren/preview")[0]?.params["template"]).toBe("default_manifest");
		controller.dispose();
	});

	it("非 statement.md 直接拒绝（只给提示，不建面板）", async () => {
		const { controller, env, hosts } = makeHarness();
		const opened = await controller.show(makeDocument(path.join(fixture.statementDir, "sol.md")), {
			beside: false,
		});
		expect(opened).toBe(false);
		expect(hosts.created).toHaveLength(0);
		expect(env.informations).toHaveLength(1);
		controller.dispose();
	});

	it("不在 Tuack 工程内时给出可操作警告", async () => {
		const loose = path.join(tempRoot, "loose", "statement.md");
		fs.mkdirSync(path.dirname(loose), { recursive: true });
		fs.writeFileSync(loose, "# x\n", "utf8");
		const { controller, env, hosts } = makeHarness();
		const opened = await controller.show(makeDocument(loose), { beside: false });
		expect(opened).toBe(false);
		expect(hosts.created).toHaveLength(0);
		expect(env.warnings[0]).toContain("conf.json");
		controller.dispose();
	});

	it("切到另一道题时复用同一个面板并更新上下文", async () => {
		const { controller, hosts } = makeHarness();
		await controller.show(makeDocument(), { beside: false });

		const otherDir = path.join(fixture.contestRoot, "day1", "p2");
		writeJson(path.join(otherDir, "conf.json"), { folder: "problem", name: "p2" });
		const otherStatement = path.join(otherDir, "statement.md");
		fs.writeFileSync(otherStatement, "# p2\n", "utf8");

		await controller.show(makeDocument(otherStatement), { beside: false });
		expect(hosts.created).toHaveLength(1);
		expect(hosts.host.context.statementPath).toBe(otherStatement);
		expect(hosts.host.revealCount).toBe(2);
		controller.dispose();
	});

	it("restore() 接管序列化恢复出来的面板", async () => {
		const { controller, rpc, hosts } = makeHarness();
		const host = new FakeHost({
			title: "p1",
			statementDir: fixture.statementDir,
			contestRoot: fixture.contestRoot,
			statementPath: fixture.statementPath,
		});
		const restored = await controller.restore(host, fixture.statementPath);
		expect(restored).toBe(true);
		expect(rpc.opened).toEqual([fixture.contestRoot]);
		expect(rpc.callsOf("ren/preview")[0]?.params["scope"]).toBe("day1/p1");
		expect(hosts.created).toHaveLength(0);
		controller.dispose();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 保存策略
// ─────────────────────────────────────────────────────────────────────────────

describe("保存策略（ren/preview 只读磁盘）", () => {
	it("saveBeforePreview=true：preview 之前先保存，不显示「未保存」提示", async () => {
		const { controller, rpc, env } = makeHarness();
		env.settings.saveBeforePreview = true;
		await controller.show(makeDocument(), { beside: false });
		expect(env.saved).toEqual([fixture.statementPath]);
		expect(env.statusBar.text).toBeUndefined();
		expect(rpc.callsOf("ren/preview")).toHaveLength(1);
		controller.dispose();
	});

	it("saveBeforePreview=false：不保存，并在状态条/状态栏写明「预览基于已保存内容」", async () => {
		const { controller, env, hosts } = makeHarness();
		env.settings.saveBeforePreview = false;
		await controller.show(makeDocument(), { beside: false });

		expect(env.saved).toEqual([]);
		expect(env.statusBar.text).toContain("preview shows the saved file");

		const statuses = hosts.host.messagesOfType("status");
		const ready = statuses[statuses.length - 1];
		expect(ready?.type === "status" ? ready.message : "").toContain("saveBeforePreview");
		controller.dispose();
	});

	it("防抖：文档变化后等 debounceMs 才重拉", async () => {
		vi.useFakeTimers();
		const { controller, rpc, env } = makeHarness();
		env.settings.debounceMs = 300;
		const document = makeDocument();

		await controller.show(document, { beside: false });
		expect(rpc.callsOf("ren/preview")).toHaveLength(1);

		env.fireChange(document);
		await vi.advanceTimersByTimeAsync(299);
		expect(rpc.callsOf("ren/preview")).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(rpc.callsOf("ren/preview")).toHaveLength(2);
		// 防抖后这一轮同样先保存（ren/preview 只读磁盘）。
		expect(env.saved.length).toBeGreaterThanOrEqual(2);
		controller.dispose();
	});

	it("面板 ready / requestUpdate 都触发一次全量 update（generation 单调递增）", async () => {
		const { controller, hosts } = makeHarness();
		await controller.show(makeDocument(), { beside: false });
		hosts.host.receive({ type: "ready" });
		await tick();
		hosts.host.receive({ type: "requestUpdate", reason: "visible" });
		await tick();

		const updates = hosts.host.messagesOfType("update");
		expect(updates.map((message) => (message.type === "update" ? message.generation : -1))).toEqual([1, 2, 3]);
		controller.dispose();
	});

	it("隐藏期间不推全量 update；重新可见后 requestUpdate 补发", async () => {
		const { controller, env, hosts } = makeHarness();
		env.settings.debounceMs = 0;
		env.settings.saveBeforePreview = false;
		await controller.show(makeDocument(), { beside: false });
		hosts.host.receive({ type: "ready" });
		await tick();
		expect(hosts.host.messagesOfType("update")).toHaveLength(2);

		// 面板隐藏：这一轮的 update 必须被跳过。
		hosts.host.visible = false;
		env.fireChange(makeDocument());
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(hosts.host.messagesOfType("update")).toHaveLength(2);

		// 重新可见：前端主动要一次全量。
		hosts.host.visible = true;
		hosts.host.receive({ type: "requestUpdate", reason: "visible" });
		await tick();
		expect(hosts.host.messagesOfType("update")).toHaveLength(3);
		controller.dispose();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// in-flight 单飞
// ─────────────────────────────────────────────────────────────────────────────

describe("in-flight 单飞", () => {
	it("同一时刻只发一个 ren/preview，期间的请求合并成一次尾随重发", async () => {
		const { controller, rpc, hosts } = makeHarness();
		const first = deferred<unknown>();
		let callCount = 0;
		rpc.handler = (method) => {
			if (method !== "ren/preview") {
				return {};
			}
			callCount += 1;
			return callCount === 1 ? first.promise : { markdown: "# later\n", warnings: [], lineMap: [] };
		};

		void controller.show(makeDocument(), { beside: false });
		await tick();
		expect(rpc.callsOf("ren/preview")).toHaveLength(1);

		// 第一次还在飞：三个请求只应合并成一个尾随重发。
		hosts.host.receive({ type: "requestUpdate", reason: "manual" });
		hosts.host.receive({ type: "requestUpdate", reason: "manual" });
		hosts.host.receive({ type: "scroll", line: 1 });
		expect(rpc.callsOf("ren/preview")).toHaveLength(1);

		first.resolve({ markdown: "# first\n", warnings: [], lineMap: [] });
		await tick(5);
		expect(rpc.callsOf("ren/preview")).toHaveLength(2);
		controller.dispose();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// conf.json → config/reload
// ─────────────────────────────────────────────────────────────────────────────

describe("conf.json 变化", () => {
	it("先 config/reload（精确 scope）再 ren/preview；之后普通编辑不再 reload", async () => {
		vi.useFakeTimers();
		const { controller, rpc, env } = makeHarness();
		env.settings.debounceMs = 0;

		const document = makeDocument();
		await controller.show(document, { beside: false });
		rpc.calls.length = 0;

		env.fireChange({ uri: new FakeUri(fixture.problemConf), isDirty: true, languageId: "json" });
		await vi.advanceTimersByTimeAsync(0);
		expect(rpc.calls.map((call) => call.method)).toEqual(["config/reload", "ren/preview"]);
		expect(rpc.callsOf("config/reload")[0]?.params["scope"]).toBe("day1/p1");

		// 下一次普通编辑：配置已 reload，不再重复 reload。
		rpc.calls.length = 0;
		env.fireChange(document);
		await vi.advanceTimersByTimeAsync(0);
		expect(rpc.calls.map((call) => call.method)).toEqual(["ren/preview"]);
		controller.dispose();
	});

	it("保存 conf.json（磁盘已变）同样触发 reload", async () => {
		vi.useFakeTimers();
		const { controller, rpc, env } = makeHarness();
		env.settings.debounceMs = 0;
		await controller.show(makeDocument(), { beside: false });
		rpc.calls.length = 0;

		env.fireSave({ uri: new FakeUri(fixture.dayConf), isDirty: false, languageId: "json" });
		await vi.advanceTimersByTimeAsync(0);
		expect(rpc.calls.map((call) => call.method)).toEqual(["config/reload", "ren/preview"]);
		controller.dispose();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 滚动同步
// ─────────────────────────────────────────────────────────────────────────────

describe("滚动同步", () => {
	async function setupScrollSync(): Promise<ReturnType<typeof makeHarness>> {
		const harness = makeHarness();
		harness.rpc.handler = () => ({
			markdown: "para one\n\n## H2\n",
			warnings: [],
			lineMap: [
				{ source: 1, rendered: 1 },
				{ source: 5, rendered: 3 },
			],
		});
		await harness.controller.show(makeDocument(), { beside: false });
		return harness;
	}

	it("预览 → 编辑器：用 sourceForRendered 换算后 revealRange", async () => {
		const { controller, env, hosts } = await setupScrollSync();
		hosts.host.receive({ type: "scroll", line: 3 });
		await tick();
		expect(env.revealed).toEqual([{ path: fixture.statementPath, line: 5 }]);
		controller.dispose();
	});

	it("编辑器 → 预览：HOST_SCROLL_LOCK_MS 内忽略回声，之后照常回报", async () => {
		const { controller, env, hosts } = await setupScrollSync();

		// 面板发起滚动 → 控制器 reveal 编辑器，记下锁起点。
		hosts.host.receive({ type: "scroll", line: 3 });
		await tick();
		expect(env.revealed).toHaveLength(1);

		// 编辑器可见行回声（同一时刻，锁定期内）：必须被忽略。
		env.fireVisibleRange(new FakeUri(fixture.statementPath), 1);
		await sleep(SCROLL_THROTTLE_MS + 20);
		expect(hosts.host.messagesOfType("scrollToLine")).toHaveLength(0);

		// 过了锁定窗口：编辑器滚动应换算成预览行发回面板（等过节流窗口）。
		env.nowValue += HOST_SCROLL_LOCK_MS + 1;
		env.fireVisibleRange(new FakeUri(fixture.statementPath), 1);
		await sleep(SCROLL_THROTTLE_MS + 20);
		const scrolls = hosts.host.messagesOfType("scrollToLine");
		expect(scrolls).toHaveLength(1);
		expect(scrolls[0]?.type === "scrollToLine" ? scrolls[0].line : -1).toBe(1);

		// 别的文档的滚动事件不影响预览。
		env.fireVisibleRange(new FakeUri(path.join(tempRoot, "other.md")), 1);
		await sleep(SCROLL_THROTTLE_MS + 20);
		expect(hosts.host.messagesOfType("scrollToLine")).toHaveLength(1);
		controller.dispose();
	});

	it("编辑器可见行按 SCROLL_THROTTLE_MS 节流并按 URI 合并（只回推最后一次）", async () => {
		const { controller, env, hosts } = await setupScrollSync();
		env.fireVisibleRange(new FakeUri(fixture.statementPath), 2);
		env.fireVisibleRange(new FakeUri(fixture.statementPath), 1);
		env.fireVisibleRange(new FakeUri(fixture.statementPath), 2);

		const scrolls = hosts.host.messagesOfType("scrollToLine");
		expect(scrolls).toHaveLength(0); // 还没到节流窗口

		await sleep(SCROLL_THROTTLE_MS + 20);
		const flushed = hosts.host.messagesOfType("scrollToLine");
		expect(flushed).toHaveLength(1);
		// 编辑器第 2 行 → lineMap {source:1→rendered:1, source:5→rendered:3} 回退到 rendered 1。
		expect(flushed[0]?.type === "scrollToLine" ? flushed[0].line : -1).toBe(1);
		controller.dispose();
	});

	it("视口没有锚点时（line=null）不动编辑器", async () => {
		const { controller, env, hosts } = await setupScrollSync();
		hosts.host.receive({ type: "scroll", line: null });
		await tick();
		expect(env.revealed).toEqual([]);
		controller.dispose();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 不可信输入 / 链接 / 图片 / 错误
// ─────────────────────────────────────────────────────────────────────────────

describe("面板消息与链接", () => {
	it("形状不合法的面板消息被忽略（不抛错、不推 update）", async () => {
		const { controller, env, hosts } = makeHarness();
		await controller.show(makeDocument(), { beside: false });
		const before = hosts.host.messagesOfType("update").length;

		hosts.host.receive("garbage");
		hosts.host.receive({ type: "nope" });
		hosts.host.receive({ type: "scroll", line: "3" });
		await tick();

		expect(hosts.host.messagesOfType("update")).toHaveLength(before);
		expect(env.logs.some((entry) => entry.level === "warn")).toBe(true);
		controller.dispose();
	});

	it("openLink：外部 http 走 openExternal，相对本地文件走编辑器，同文档锚点忽略", async () => {
		const { controller, env, hosts } = makeHarness();
		await controller.show(makeDocument(), { beside: false });

		fs.writeFileSync(path.join(fixture.statementDir, "sol.md"), "# sol\n", "utf8");

		hosts.host.receive({ type: "openLink", href: "https://example.com/x", line: 1 });
		hosts.host.receive({ type: "openLink", href: "./sol.md", line: 2 });
		hosts.host.receive({ type: "openLink", href: "#fragment", line: 3 });
		await tick();

		expect(env.openedExternal).toEqual(["https://example.com/x"]);
		expect(env.openedResources).toEqual([path.join(fixture.statementDir, "sol.md")]);
		controller.dispose();
	});

	it("openImage：用改写前的原始 src 打开本地图片", async () => {
		const { controller, env, hosts } = makeHarness();
		await controller.show(makeDocument(), { beside: false });

		const imageDir = path.join(fixture.statementDir, "img");
		fs.mkdirSync(imageDir, { recursive: true });
		fs.writeFileSync(path.join(imageDir, "a.png"), "not-a-real-png", "utf8");

		hosts.host.receive({
			type: "openImage",
			src: `vscode-webview://${path.join(imageDir, "a.png")}`,
			originalSrc: "img/a.png",
			line: 1,
		});
		await tick();

		expect(env.openedResources).toEqual([path.join(imageDir, "a.png")]);
		controller.dispose();
	});

	it("把题面里的相对图片改写成 webview URI（assets 映射）", async () => {
		const { controller, rpc, hosts } = makeHarness();
		const imageDir = path.join(fixture.statementDir, "img");
		fs.mkdirSync(imageDir, { recursive: true });
		fs.writeFileSync(path.join(imageDir, "a.png"), "x", "utf8");
		rpc.handler = () => ({
			markdown: "![pic](img/a.png)\n\n![missing](img/nope.png)\n",
			warnings: [],
			lineMap: [],
		});

		await controller.show(makeDocument(), { beside: false });
		const update = hosts.host.messagesOfType("update")[0];
		if (update?.type !== "update") {
			throw new Error("expected an update message");
		}
		expect(update.assets).toEqual({
			"img/a.png": `vscode-webview://${path.join(imageDir, "a.png")}`,
		});
		controller.dispose();
	});

	it("ren/preview 失败时把错误写进面板状态并记日志", async () => {
		const { controller, rpc, env, hosts } = makeHarness();
		rpc.handler = () => {
			throw new Error("boom: 渲染失败");
		};

		await controller.show(makeDocument(), { beside: false });

		const statuses = hosts.host.messagesOfType("status");
		const last = statuses[statuses.length - 1];
		expect(last).toMatchObject({ state: "error" });
		expect(last?.type === "status" ? last.message : "").toContain("boom");
		expect(env.logs.some((entry) => entry.level === "error")).toBe(true);
		controller.dispose();
	});
});
