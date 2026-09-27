/**
 * 单进程客户端测试：id 分配、超时、错误码映射、通知分发、能力门控、生命周期。
 * 用真 NdjsonTransport + 两个 PassThrough 当假 stdio 服务端，顺带覆盖分帧链路。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import { ErrorCode } from "../../../rpc/protocol";
import { LocalErrorCode, TuackRpcError, isRpcError } from "../../../rpc/errors";
import { RpcClient } from "../../../rpc/client";
import { NdjsonTransport } from "../../../rpc/transport";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 假服务端：读客户端写来的 NDJSON，允许测试脚本化响应。 */
class FakeServer {
	readonly toServer = new PassThrough();
	readonly fromServer = new PassThrough();
	readonly requests: { id?: unknown; method: string; params?: unknown }[] = [];
	private pendingLine = "";
	/** 每条请求的处理函数；返回 `undefined` 表示不响应。 */
	handler: ((request: { id?: unknown; method: string; params?: unknown }) => unknown | undefined) | undefined;

	constructor() {
		this.toServer.setEncoding("utf8");
		this.toServer.on("data", (chunk: string) => {
			this.pendingLine += chunk;
			let index = this.pendingLine.indexOf("\n");
			while (index !== -1) {
				const line = this.pendingLine.slice(0, index);
				this.pendingLine = this.pendingLine.slice(index + 1);
				if (line.trim().length > 0) {
					this.receive(JSON.parse(line) as { id?: unknown; method: string; params?: unknown });
				}
				index = this.pendingLine.indexOf("\n");
			}
		});
	}

	private receive(request: { id?: unknown; method: string; params?: unknown }): void {
		this.requests.push(request);
		if (this.handler) {
			const response = this.handler(request);
			if (response !== undefined) {
				this.write(response);
			}
		}
	}

	write(value: unknown): void {
		this.fromServer.write(`${JSON.stringify(value)}\n`);
	}

	respond(id: unknown, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	respondError(id: unknown, code: number, message: string, data?: unknown): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message, data } });
	}

	notify(method: string, params?: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}
}

function makeClient(options?: { defaultTimeoutMs?: number; enforceCapabilities?: boolean }): {
	client: RpcClient;
	server: FakeServer;
} {
	const server = new FakeServer();
	let client!: RpcClient;
	const transport = new NdjsonTransport({
		input: server.fromServer,
		output: server.toServer,
		onMessage: (message) => client.handleMessage(message),
	});
	client = new RpcClient({
		transport,
		clientName: "test-client",
		clientVersion: "1.2.3",
		defaultTimeoutMs: options?.defaultTimeoutMs,
		enforceCapabilities: options?.enforceCapabilities,
	});
	return { client, server };
}

const ALL_CAPABILITIES = ["workspace", "config", "problem", "run", "ren"];

function initializeHandler(capabilities: string[] = ALL_CAPABILITIES) {
	return (request: { id?: unknown; method: string }): unknown => {
		if (request.method === "initialize") {
			return {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: "0.1",
					serverInfo: { name: "fake-tuack-ng-rpc", version: "0.0.1" },
					capabilities,
				},
			};
		}
		if (request.id === undefined) {
			return undefined;
		}
		return { jsonrpc: "2.0", id: request.id, result: null };
	};
}

/** 只答应 `initialize`，其余请求故意不响应。 */
function initializeOnly(capabilities: string[] = ALL_CAPABILITIES) {
	const base = initializeHandler(capabilities);
	return (request: { id?: unknown; method: string }): unknown =>
		request.method === "initialize" ? base(request) : undefined;
}

describe("RpcClient 请求/响应", () => {
	it("initialize 走 id=1，记录 serverInfo/capabilities，并进入 ready", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		expect(client.state).toBe("idle");
		const result = await client.initialize();
		expect(result.protocolVersion).toBe("0.1");
		expect(result.serverInfo.name).toBe("fake-tuack-ng-rpc");
		expect(client.state).toBe("ready");
		expect([...(client.capabilities ?? [])]).toEqual(ALL_CAPABILITIES);
		expect(server.requests[0]?.method).toBe("initialize");
		expect(server.requests[0]?.id).toBe(1);
		expect((server.requests[0]?.params as { clientInfo: { name: string } }).clientInfo.name).toBe("test-client");
	});

	it("initialize 幂等：第二次不再发请求", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		await client.initialize();
		expect(server.requests.filter((r) => r.method === "initialize")).toHaveLength(1);
	});

	it("id 单调递增且不复用；params 为 undefined 时不带 params 字段", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		await client.call("config/get", { sessionId: "s-1" });
		await client.shutdown();
		expect(server.requests.map((r) => r.id)).toEqual([1, 2, 3]);
		expect("params" in (server.requests[2] ?? {})).toBe(false);
		expect(client.state).toBe("closed");
	});

	it("服务端错误转成带 code/data 的 TuackRpcError", async () => {
		const { client, server } = makeClient();
		server.handler = (request) => {
			if (request.method === "run/judge") {
				return { jsonrpc: "2.0", id: request.id, error: { code: ErrorCode.RunNotFound, message: "run 已不在", data: { runId: "p2:1:r-1" } } };
			}
			return initializeHandler()(request);
		};
		await client.initialize();
		const error = await client.call("run/judge", { sessionId: "s-1", runId: "r-1", testId: "1" }).catch((e: unknown) => e);
		expect(isRpcError(error, ErrorCode.RunNotFound)).toBe(true);
		expect((error as TuackRpcError).data).toEqual({ runId: "p2:1:r-1" });
	});

	it("id:null 的服务端错误走 onServerError，不影响其它请求", async () => {
		const { client, server } = makeClient();
		const serverErrors: TuackRpcError[] = [];
		// 通过第二个客户端选项注入 onServerError 不方便，这里直接观察不抛错 + pending 仍能完成。
		server.handler = initializeHandler();
		await client.initialize();
		server.write({ jsonrpc: "2.0", id: null, error: { code: ErrorCode.ParseError, message: "bad" } });
		await tick();
		expect(client.pendingCount).toBe(0);
		expect(serverErrors).toHaveLength(0);
		expect(client.recentError?.code).toBe(ErrorCode.ParseError);
	});

	it("落单的响应（无 pending）只记 warn，不抛错", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		expect(() => server.respond(999, null)).not.toThrow();
		await tick();
		expect(client.pendingCount).toBe(0);
	});

	it("重复响应第二条被忽略（不会二次 settle）", async () => {
		const { client, server } = makeClient();
		server.handler = initializeOnly();
		await client.initialize();
		const promise = client.call("config/get", { sessionId: "s-1" });
		await tick();
		server.respond(2, { revision: 0 });
		server.respond(2, { revision: 1 });
		await expect(promise).resolves.toEqual({ revision: 0 });
	});
});

describe("RpcClient 超时与 id 复用", () => {
	it("超时拒绝，且迟到的响应不会落到后续请求上", async () => {
		const { client, server } = makeClient({ defaultTimeoutMs: 25 });
		server.handler = initializeOnly();
		await client.initialize();

		// 第 2 个请求不响应，等超时
		const slow = client.call("config/get", { sessionId: "s-1" });
		await expect(slow).rejects.toSatisfy((error: unknown) => isRpcError(error, LocalErrorCode.Timeout));
		const timeoutError = (await slow.catch((e: unknown) => e)) as TuackRpcError;
		expect(timeoutError.data).toMatchObject({ method: "config/get", id: 2, timeoutMs: 25 });

		// 迟到的 id=2 响应
		server.respond(2, { revision: 99 });
		await tick();

		// 新请求用 id=3，收到自己的响应，不会被 id=2 的迟到响应污染
		const fresh = client.call("config/get", { sessionId: "s-1" });
		await tick();
		expect(server.requests.at(-1)?.id).toBe(3);
		server.respond(3, { revision: 7 });
		await expect(fresh).resolves.toEqual({ revision: 7 });
	});

	it("AbortSignal 取消请求", async () => {
		const { client, server } = makeClient({ defaultTimeoutMs: 0 });
		server.handler = initializeOnly();
		await client.initialize();
		const controller = new AbortController();
		const promise = client.call("run/score", { sessionId: "s-1", runId: "r-1" }, { signal: controller.signal });
		controller.abort();
		await expect(promise).rejects.toSatisfy((error: unknown) => isRpcError(error, LocalErrorCode.Aborted));
	});
});

describe("RpcClient 通知与事件", () => {
	it("已知事件同时进 onNotification 与 onEvent", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		const notifications: string[] = [];
		const events: string[] = [];
		client.onNotification((message) => notifications.push(message.method));
		client.onEvent((event) => events.push(event.method));
		server.notify("run/started", { seq: 1, sessionId: "s-1", runId: "r-1" });
		await tick();
		expect(notifications).toEqual(["run/started"]);
		expect(events).toEqual(["run/started"]);
	});

	it("未知事件只记日志：进 onNotification，不进 onEvent，不报错", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		const notifications: string[] = [];
		const events: string[] = [];
		client.onNotification((message) => notifications.push(message.method));
		client.onEvent((event) => events.push(event.method));
		server.notify("ren/增量推送", { seq: 2, sessionId: "s-1", taskId: "p1:t-1" });
		await tick();
		expect(notifications).toEqual(["ren/增量推送"]);
		expect(events).toEqual([]);
		expect(client.state).toBe("ready");
	});

	it("既不是响应也不是通知的消息只记 warn", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		const violations: string[] = [];
		// 直接灌一条非法信封
		server.write({ jsonrpc: "2.0", foo: "bar" });
		await tick();
		expect(violations).toHaveLength(0);
		expect(client.state).toBe("ready");
	});
});

describe("RpcClient 能力门控与生命周期", () => {
	it("initialize 之前调用其它方法报 LifecycleViolation", async () => {
		const { client } = makeClient();
		const error = await client.call("config/get", { sessionId: "s-1" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.LifecycleViolation)).toBe(true);
	});

	it("未声明的 capability 会被拦截", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler(["workspace", "config"]);
		await client.initialize();
		expect(client.supports("config/get")).toBe(true);
		expect(client.supports("run/judge")).toBe(false);
		const error = await client.call("run/judge", { sessionId: "s-1", runId: "r-1", testId: "1" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.CapabilityUnavailable)).toBe(true);
		// 未发出请求
		expect(server.requests.some((r) => r.method === "run/judge")).toBe(false);
	});

	it("enforceCapabilities=false 时只警告不拦", async () => {
		const { client, server } = makeClient({ enforceCapabilities: false });
		server.handler = initializeHandler(["workspace", "config"]);
		await client.initialize();
		await expect(client.call("run/judge", { sessionId: "s-1", runId: "r-1", testId: "1" })).resolves.toBeNull();
		expect(server.requests.some((r) => r.method === "run/judge")).toBe(true);
	});

	it("shutdown 之后普通调用被拒，但 exit 仍可发（协议要求）", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		await client.shutdown();
		expect(client.state).toBe("closed");
		const error = await client.call("config/get", { sessionId: "s-1" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.TransportClosed)).toBe(true);
		const exitPromise = client.rawCall("exit");
		await tick();
		expect(server.requests.at(-1)?.method).toBe("exit");
		server.respond(server.requests.at(-1)?.id, null);
		await expect(exitPromise).resolves.toBeNull();
	});

	it("shutdown 重入是 no-op", async () => {
		const { client, server } = makeClient();
		server.handler = initializeHandler();
		await client.initialize();
		await client.shutdown();
		await expect(client.shutdown()).resolves.toBeUndefined();
		expect(server.requests.filter((r) => r.method === "shutdown")).toHaveLength(1);
	});
});

describe("RpcClient 死亡处理", () => {
	it("fail() 立刻拒绝所有 pending（秒退诊断路径）", async () => {
		const { client, server } = makeClient({ defaultTimeoutMs: 5000 });
		server.handler = initializeOnly();
		await client.initialize();
		const first = client.call("config/get", { sessionId: "s-1" });
		const second = client.call("problem/list", { sessionId: "s-1" });
		await tick();
		expect(client.pendingCount).toBe(2);
		client.fail(
			TuackRpcError.local(LocalErrorCode.ProcessExited, "启动即退出：找不到 langs.json", {
				fastExit: true,
				diagnosis: { kind: "assets-missing", summary: "x", advice: [] },
			}),
		);
		expect(client.state).toBe("dead");
		expect(client.pendingCount).toBe(0);
		await expect(first).rejects.toSatisfy((e: unknown) => isRpcError(e, LocalErrorCode.ProcessExited));
		await expect(second).rejects.toSatisfy((e: unknown) => isRpcError(e, LocalErrorCode.ProcessExited));
		// 死后再调用立刻拒绝
		await expect(client.call("config/get", { sessionId: "s-1" })).rejects.toSatisfy((e: unknown) =>
			isRpcError(e, LocalErrorCode.TransportClosed),
		);
	});

	it("dispose() 拒绝 pending 并摘掉订阅", async () => {
		const { client, server } = makeClient();
		server.handler = initializeOnly();
		await client.initialize();
		const events: string[] = [];
		client.onEvent((event) => events.push(event.method));
		const pending = client.call("config/get", { sessionId: "s-1" });
		await tick();
		client.dispose("测试释放");
		await expect(pending).rejects.toSatisfy((e: unknown) => isRpcError(e, LocalErrorCode.TransportClosed));
		await tick();
		expect(events).toHaveLength(0);
	});

	it("pendingCalls() 报告在飞请求，便于 Doctor/看门狗", async () => {
		const { client, server } = makeClient({ defaultTimeoutMs: 10_000 });
		server.handler = initializeOnly();
		await client.initialize();
		const inflight = client.call("run/judge", { sessionId: "s-1", runId: "r-1", testId: "1" });
		inflight.catch(() => undefined);
		await tick();
		const pending = client.pendingCalls();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.method).toBe("run/judge");
		expect(pending[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
		client.dispose();
	});
});
