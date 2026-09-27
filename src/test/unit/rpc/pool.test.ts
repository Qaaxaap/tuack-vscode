/**
 * 进程池测试（用假端点，不 spawn 真进程）。
 *
 * 锁住的行为：
 * - P1 常驻、P2 按需 spawn / 空闲回收 / 递增 epoch；
 * - id 命名空间化（`p1:` / `p2:<epoch>:`）与按前缀反向路由；
 * - **早到事件**（`run/started` 先于 `runId` 响应）缓冲后回放；
 * - P2 禁止 `config/set` / `config/migrate`；
 * - capabilities 门控；未知事件只记日志；
 * - session 改写（session 是进程级的，跨进程必 -32001）。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import type {
	Capability,
	MethodName,
	MethodParams,
	MethodResult,
	RpcEvent,
	RpcNotification,
	RunStartedEvent,
	SessionId,
} from "../../../rpc/protocol";
import { LocalErrorCode, isRpcError } from "../../../rpc/errors";
import {
	RpcPool,
	namespacedId,
	roleForMethod,
	splitNamespacedId,
	type EndpointRequest,
	type PoolEventMeta,
	type PoolRole,
	type RpcEndpoint,
} from "../../../rpc/pool";

const ALL_CAPABILITIES: Capability[] = ["workspace", "config", "problem", "run", "ren"];

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

class FakeEndpoint implements RpcEndpoint {
	readonly role: PoolRole;
	readonly namespace: string;
	readonly sessionId: SessionId;
	readonly capabilities: ReadonlySet<Capability> | undefined;
	alive = true;
	pid = 4242;
	readonly calls: { method: string; params: unknown }[] = [];
	shutdownCount = 0;
	killCount = 0;
	responder: (method: string, params: unknown) => unknown = () => null;
	private readonly handlers = new Set<(message: RpcNotification) => void>();

	constructor(role: PoolRole, namespace: string, sessionId: SessionId, capabilities: Capability[] = ALL_CAPABILITIES) {
		this.role = role;
		this.namespace = namespace;
		this.sessionId = sessionId;
		this.capabilities = new Set(capabilities);
	}

	async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
		this.calls.push({ method, params });
		return (await this.responder(method, params)) as MethodResult<M>;
	}

	onNotification(handler: (message: RpcNotification) => void): { dispose: () => void } {
		this.handlers.add(handler);
		return {
			dispose: () => {
				this.handlers.delete(handler);
			},
		};
	}

	/** 以真实线上形态发出事件：JSON-RPC 通知 + `params` 负载。 */
	emit(method: string, params: Record<string, unknown>): void {
		const message = { jsonrpc: "2.0", method, params } as RpcNotification;
		for (const handler of [...this.handlers]) {
			handler(message);
		}
	}

	async shutdown(): Promise<void> {
		this.shutdownCount += 1;
		this.alive = false;
	}

	async kill(): Promise<void> {
		this.killCount += 1;
		this.alive = false;
	}

	lastCall(method: string): { method: string; params: unknown } | undefined {
		return [...this.calls].reverse().find((call) => call.method === method);
	}
}

interface Harness {
	pool: RpcPool;
	created: FakeEndpoint[];
	requests: EndpointRequest[];
	p1: () => FakeEndpoint;
	p2: (epoch?: number) => FakeEndpoint;
}

function makePool(options: { p2IdleTimeoutMs?: number; p1Capabilities?: Capability[] } = {}): Harness {
	const created: FakeEndpoint[] = [];
	const requests: EndpointRequest[] = [];
	let runCounter = 0;
	let taskCounter = 0;
	const pool = new RpcPool({
		workspaceUri: "file:///contest",
		p2IdleTimeoutMs: options.p2IdleTimeoutMs ?? 0,
		createEndpoint: async (request) => {
			requests.push(request);
			const endpoint = new FakeEndpoint(
				request.role,
				request.namespace,
				request.role === "p1" ? "s-p1" : `s-${request.namespace}`,
				request.role === "p1" ? (options.p1Capabilities ?? ALL_CAPABILITIES) : ALL_CAPABILITIES,
			);
			endpoint.responder = (method) => {
				if (method === "run/create") {
					runCounter += 1;
					return { runId: `r-${runCounter}` };
				}
				if (method === "ren/run") {
					taskCounter += 1;
					return { taskId: `t-${taskCounter}` };
				}
				return null;
			};
			created.push(endpoint);
			return endpoint;
		},
	});
	return {
		pool,
		created,
		requests,
		p1: () => created.find((endpoint) => endpoint.role === "p1") as FakeEndpoint,
		p2: (epoch = 1) => created.find((endpoint) => endpoint.namespace === `p2:${epoch}`) as FakeEndpoint,
	};
}

describe("id 命名空间工具", () => {
	it("roleForMethod：run/* 走 P2，其余走 P1", () => {
		expect(roleForMethod("run/create")).toBe("p2");
		expect(roleForMethod("run/judge")).toBe("p2");
		expect(roleForMethod("config/get")).toBe("p1");
		expect(roleForMethod("ren/preview")).toBe("p1");
		expect(roleForMethod("workspace/open")).toBe("p1");
	});

	it("namespacedId 幂等；splitNamespacedId 从最后一个冒号切", () => {
		expect(namespacedId("p1", "r-1")).toBe("p1:r-1");
		expect(namespacedId("p1", "p1:r-1")).toBe("p1:r-1");
		expect(splitNamespacedId("p1:12")).toEqual({ namespace: "p1", id: "12" });
		expect(splitNamespacedId("p2:3:12")).toEqual({ namespace: "p2:3", id: "12" });
		expect(splitNamespacedId("r-1")).toBeUndefined();
		expect(splitNamespacedId(":x")).toBeUndefined();
		expect(splitNamespacedId("x:")).toBeUndefined();
	});
});

describe("RpcPool 生命周期", () => {
	it("P1 惰性创建并复用；workspaceUri 传给工厂", async () => {
		const { pool, created, requests } = makePool();
		expect(created).toHaveLength(0);
		const first = await pool.control();
		const second = await pool.control();
		expect(created).toHaveLength(1);
		expect(first.namespace).toBe("p1");
		expect(second.namespace).toBe("p1");
		expect(first.sessionId).toBe("s-p1");
		expect(requests[0]?.workspaceUri).toBe("file:///contest");
	});

	it("P2 按需 spawn，回收后 epoch 递增（新命名空间）", async () => {
		const { pool, created } = makePool();
		expect(pool.hasEvaluation).toBe(false);
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		expect(pool.currentEvaluationNamespace).toBe("p2:1");
		expect(created).toHaveLength(1); // 只有 P2，没有 P1
		expect(pool.p2Epoch).toBe(1);

		await pool.recycleEvaluation("test");
		expect(pool.hasEvaluation).toBe(false);
		expect(created[0]?.shutdownCount).toBe(1);

		const next = await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		expect(next.runId).toBe("p2:2:r-2");
		expect(created).toHaveLength(2);
	});

	it("dispose 回收两端，之后调用立即拒绝", async () => {
		const { pool, created } = makePool();
		await pool.call("config/get", { sessionId: "stale" });
		await pool.call("run/create", { sessionId: "stale", problem: "day1/p1", target: "data" });
		await pool.dispose();
		expect(created.every((endpoint) => endpoint.shutdownCount === 1)).toBe(true);
		const error = await pool.call("config/get", { sessionId: "x" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.TransportClosed)).toBe(true);
	});

	it("回收与 spawn 竞态：在飞的 P2 创建结果被作废并立刻回收", async () => {
		const created: FakeEndpoint[] = [];
		const gate = deferred<RpcEndpoint>();
		const pool = new RpcPool({
			workspaceUri: "file:///contest",
			p2IdleTimeoutMs: 0,
			createEndpoint: async (request) => {
				const endpoint = new FakeEndpoint(request.role, request.namespace, "s-slow");
				created.push(endpoint);
				await gate.promise;
				return endpoint;
			},
		});

		const pending = pool.evaluation();
		await tick();
		// 评测在 P2 起来之前被取消/回收
		await pool.recycleEvaluation("cancel-during-spawn");
		gate.resolve(created[0] as FakeEndpoint);

		await expect(pending).rejects.toSatisfy((error: unknown) => isRpcError(error, LocalErrorCode.TransportClosed));
		expect(pool.hasEvaluation).toBe(false);
		expect(created[0]?.shutdownCount).toBe(1);
		await pool.dispose();
	});

	it("空闲到点回收 P2，但**在飞请求期间不回收**", async () => {
		const { pool, created } = makePool({ p2IdleTimeoutMs: 40 });
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		const p2 = created[0] as FakeEndpoint;
		expect(pool.hasEvaluation).toBe(true);

		// 一个慢请求在飞：run/judge 这类同步 handler 可能远长于空闲阈值
		p2.responder = () => new Promise((resolve) => setTimeout(() => resolve(null), 160));
		const inflight = pool.call("run/score", { sessionId: "x", runId: "p2:1:r-1" });
		await delay(110);
		expect(pool.hasEvaluation).toBe(true);
		expect(p2.shutdownCount).toBe(0);
		await inflight;

		await delay(140);
		expect(pool.hasEvaluation).toBe(false);
		expect(p2.shutdownCount).toBe(1);
	});
});

describe("RpcPool 路由与 session 改写", () => {
	it("config/* 自动走 P1，并把 sessionId 改写成 P1 自己的 session", async () => {
		const { pool, created } = makePool();
		await pool.call("config/get", { sessionId: "stale-session", scope: "day1/p1" });
		expect(created).toHaveLength(1);
		expect(created[0]?.role).toBe("p1");
		expect(created[0]?.lastCall("config/get")?.params).toEqual({ sessionId: "s-p1", scope: "day1/p1" });
	});

	it("run/* 自动走 P2，sessionId 用 P2 自己的", async () => {
		const { pool, created } = makePool();
		await pool.call("run/create", { sessionId: "stale", problem: "day1/p1", target: "data" });
		const p2 = created[0] as FakeEndpoint;
		expect(p2.role).toBe("p2");
		expect(p2.lastCall("run/create")?.params).toEqual({ sessionId: "s-p2:1", problem: "day1/p1", target: "data" });
	});

	it("run/create 的 runId 会加 P2 命名空间前缀，重复创建复用同一 P2", async () => {
		const { pool, created } = makePool();
		const first = await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		const second = await pool.call("run/create", { sessionId: "x", problem: "day1/p2", target: "sample" });
		expect(first.runId).toBe("p2:1:r-1");
		expect(second.runId).toBe("p2:1:r-2");
		expect(created).toHaveLength(1);
	});

	it("带前缀的 runId 会按前缀路由并剥掉前缀（run/judge）", async () => {
		const { pool, created } = makePool();
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		const p2 = created[0] as FakeEndpoint;
		await pool.call("run/judge", { sessionId: "stale", runId: "p2:1:r-1", testId: "3" });
		expect(p2.lastCall("run/judge")?.params).toEqual({ sessionId: "s-p2:1", runId: "r-1", testId: "3" });
	});

	it("ren/run 的 taskId 加 P1 前缀，ren/get 按前缀剥回", async () => {
		const { pool, created } = makePool();
		const created1 = await pool.call("ren/run", { sessionId: "stale", template: "default", scope: "day1/p1" });
		expect(created1.taskId).toBe("p1:t-1");
		await pool.call("ren/get", { sessionId: "stale", taskId: "p1:t-1" });
		expect(created[0]?.lastCall("ren/get")?.params).toEqual({ sessionId: "s-p1", taskId: "t-1" });
	});

	it("已回收进程的 runId → ProcessExited（run 只活在进程内存里）", async () => {
		const { pool } = makePool();
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		expect(pool.isStreamAlive("run", "p2:1:r-1")).toBe(true);
		await pool.recycleEvaluation("test");
		expect(pool.isStreamAlive("run", "p2:1:r-1")).toBe(false);
		const error = await pool.call("run/judge", { sessionId: "x", runId: "p2:1:r-1", testId: "1" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.ProcessExited)).toBe(true);
		expect((error as { message: string }).message).toContain("已回收");
	});

	it("没有前缀的 id 按方法自动路由（宽容处理）", async () => {
		const { pool, created } = makePool();
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		await pool.call("run/judge", { sessionId: "x", runId: "r-1", testId: "1" });
		expect(created[0]?.lastCall("run/judge")?.params).toEqual({ sessionId: "s-p2:1", runId: "r-1", testId: "1" });
	});
});

describe("RpcPool 硬纪律与门控", () => {
	it("P2 上禁止 config/set 与 config/migrate", async () => {
		const { pool, created } = makePool();
		const setError = await pool
			.callOn("p2", "config/set", { sessionId: "x", value: 1 })
			.catch((e: unknown) => e);
		expect(isRpcError(setError, LocalErrorCode.RoleForbidden)).toBe(true);
		const migrateError = await pool
			.callOn("p2", "config/migrate", { sessionId: "x" })
			.catch((e: unknown) => e);
		expect(isRpcError(migrateError, LocalErrorCode.RoleForbidden)).toBe(true);
		// 请求没有被发给 P2
		const p2 = created.find((endpoint) => endpoint.role === "p2");
		expect(p2?.calls.some((call) => call.method === "config/set" || call.method === "config/migrate")).toBe(false);
	});

	it("自动路由下 config/set 走 P1（唯一的配置写者）", async () => {
		const { pool, created } = makePool();
		await pool.call("config/set", { sessionId: "x", value: 1 });
		expect(created[0]?.role).toBe("p1");
		expect(created[0]?.lastCall("config/set")?.params).toEqual({ sessionId: "s-p1", value: 1 });
	});

	it("capabilities 门控：P1 未声明 config 时拒绝 config/get", async () => {
		const { pool } = makePool({ p1Capabilities: ["workspace"] });
		const error = await pool.call("config/get", { sessionId: "x" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.CapabilityUnavailable)).toBe(true);
	});

	it("未知事件方法只记日志，不抛错也不投递", async () => {
		const { pool, created } = makePool();
		const events: RpcEvent[] = [];
		pool.onEvent((event) => events.push(event));
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		const p2 = created[0] as FakeEndpoint;
		expect(() => p2.emit("ren/incremental-preview", { seq: 1, sessionId: "s", taskId: "t-1" })).not.toThrow();
		expect(events).toHaveLength(0);
	});
});

describe("RpcPool 早到事件回放", () => {
	it("run/started 先于 runId 响应到达：先缓冲，响应后回放并带命名空间", async () => {
		const { pool, created } = makePool();
		const received: { event: RpcEvent; meta: PoolEventMeta }[] = [];
		pool.onEvent((event, meta) => received.push({ event, meta }));

		// 先建 P2（不经过 run/create），方便手动控制响应时机
		await pool.evaluation();
		const p2 = created[0] as FakeEndpoint;
		const gate = deferred<unknown>();
		p2.responder = (method) => (method === "run/create" ? gate.promise : null);

		const createPromise = pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		await tick();

		// 事件早于响应
		p2.emit("run/started", {
			seq: 1,
			sessionId: "s-p2:1",
			runId: "r-9",
			problem: "day1/p1",
			target: "data",
			tester: "std",
		});
		expect(received).toHaveLength(0);

		gate.resolve({ runId: "r-9" });
		const result = await createPromise;
		expect(result.runId).toBe("p2:1:r-9");

		expect(received).toHaveLength(1);
		expect(received[0]?.event.method).toBe("run/started");
		expect((received[0]?.event as RunStartedEvent).runId).toBe("p2:1:r-9");
		expect(received[0]?.meta).toEqual({ role: "p2", namespace: "p2:1" });

		// 回放之后，同 id 的事件直接投递
		p2.emit("run/output", { seq: 2, sessionId: "s-p2:1", runId: "r-9", testId: null, channel: "compiler", text: "ok" });
		expect(received).toHaveLength(2);
		expect(received[1]?.event.method).toBe("run/output");
	});

	it("多个早到事件按到达顺序回放；seq 缺口只记日志", async () => {
		const { pool, created } = makePool();
		const methods: string[] = [];
		pool.onEvent((event) => methods.push(event.method));
		await pool.evaluation();
		const p2 = created[0] as FakeEndpoint;
		const gate = deferred<unknown>();
		p2.responder = (method) => (method === "run/create" ? gate.promise : null);

		const createPromise = pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		await tick();
		// seq 故意从 7 开始（缺口）
		p2.emit("run/started", { seq: 7, sessionId: "s", runId: "r-1", problem: "d/p", target: "data", tester: "std" });
		p2.emit("run/output", { seq: 8, sessionId: "s", runId: "r-1", testId: null, channel: "judge", text: "a" });
		p2.emit("run/ready", { seq: 9, sessionId: "s", runId: "r-1" });
		gate.resolve({ runId: "r-1" });
		await createPromise;
		expect(methods).toEqual(["run/started", "run/output", "run/ready"]);
	});

	it("终态（run/finished）之后同 id 事件不再投递（已遗忘）", async () => {
		const { pool, created } = makePool();
		const methods: string[] = [];
		pool.onEvent((event) => methods.push(event.method));
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		const p2 = created[0] as FakeEndpoint;
		// run/started 早到 → 缓冲 → 响应后回放
		p2.emit("run/started", { seq: 1, sessionId: "s", runId: "r-1", problem: "d/p", target: "data", tester: "std" });
		p2.emit("run/finished", { seq: 2, sessionId: "s", runId: "r-1", state: "closed" });
		expect(methods).toEqual(["run/started", "run/finished"]);
		// 终态后的事件不应再投递（id 已被遗忘，进入缓冲）
		p2.emit("run/output", { seq: 3, sessionId: "s", runId: "r-1", testId: null, channel: "judge", text: "late" });
		expect(methods).toEqual(["run/started", "run/finished"]);
	});

	it("按方法订阅可以拿到收窄后的事件", async () => {
		const { pool, created } = makePool();
		const ids: string[] = [];
		pool.onEventMethod("run/started", (event) => ids.push(event.runId));
		await pool.call("run/create", { sessionId: "x", problem: "day1/p1", target: "data" });
		const p2 = created[0] as FakeEndpoint;
		p2.emit("run/started", { seq: 1, sessionId: "s", runId: "r-1", problem: "d/p", target: "data", tester: "std" });
		expect(ids).toEqual(["p2:1:r-1"]);
	});

	it("回收 P2 时丢弃它未归属的早到事件", async () => {
		const { pool, created } = makePool();
		const methods: string[] = [];
		pool.onEvent((event) => methods.push(event.method));
		await pool.evaluation();
		const p2 = created[0] as FakeEndpoint;
		// 没有任何 create 请求，事件无处归属 → 缓冲
		p2.emit("run/started", { seq: 1, sessionId: "s", runId: "r-404", problem: "d/p", target: "data", tester: "std" });
		expect(methods).toHaveLength(0);
		await pool.recycleEvaluation("test");
		expect(methods).toHaveLength(0);
	});
});
