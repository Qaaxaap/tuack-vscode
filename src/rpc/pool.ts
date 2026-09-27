/**
 * RPC 进程池：**控制面（P1）常驻 + 评测面（P2）按需 spawn / 空闲回收**。
 *
 * 为什么必须两个进程（协议硬约束，见 protocol.ts 顶部）：
 * - `run/judge`、`run/score`、`ren/preview`、`config/*` 是**同步 handler**，会阻塞该进程的
 *   读循环——阻塞期间该进程发不出任何请求（连 `run/cancel` 都发不出）。评测会长时间阻塞，
 *   所以配置与预览必须在另一个进程里，否则评测一开始整个前端就僵住。
 * - `revision` 与 id 计数器是**进程级**：跨进程乐观并发不成立（`-32007` 永远不会触发）。
 *   因此 **P2 禁止 `config/set` / `config/migrate`**，配置只由 P1 写。
 *
 * 池层额外负责：
 * - **id 命名空间化**：`p1:r-1`、`p2:3:r-1`。对外只暴露带前缀的 id，回来时按前缀路由。
 * - **早到事件**：`run/started` 会**先于** `runId` 响应发出；未登记的 id 先缓冲，响应到达后回放。
 * - **capabilities 门控**：`initialize` 声明的能力之外的方法不调用。
 * - **未知 method / 未知事件只记日志**。
 */

import {
	ErrorCode,
	isKnownEvent,
	type Capability,
	type MethodName,
	type MethodParams,
	type MethodResult,
	type RpcEvent,
	type RpcNotification,
	type SessionId,
} from "./protocol";
import { LocalErrorCode, TuackRpcError, asRpcError } from "./errors";
import type { RpcCallOptions } from "./client";
import {
	EventCorrelator,
	SeqTracker,
	RpcEventBus,
	capabilityForMethod,
	streamIdFromResult,
	streamIdOfEvent,
	streamKindOfMethod,
	toDisposable,
	toRpcEvent,
	type Disposable,
	type StreamKind,
} from "./events";
import { spawnRpcProcess, type RpcExitInfo, type RpcProcess } from "../core/process";
import { logger } from "../core/log";

export type PoolRole = "p1" | "p2";

/** 池中的一条连接（真实进程或测试替身）。 */
export interface RpcEndpoint {
	readonly role: PoolRole;
	/** 形如 `p1` / `p2:3`，所有对外 id 以此为前缀。 */
	readonly namespace: string;
	/** 该进程 `workspace/open` 得到的 session（**每进程一个**）。 */
	readonly sessionId: SessionId;
	readonly capabilities: ReadonlySet<Capability> | undefined;
	readonly alive: boolean;
	/** 诊断用。 */
	readonly pid?: number | undefined;
	readonly stderrTail?: (() => string) | undefined;
	call<M extends MethodName>(method: M, params: MethodParams<M>, options?: RpcCallOptions): Promise<MethodResult<M>>;
	onNotification(handler: (message: RpcNotification) => void): Disposable;
	/** 优雅回收（shutdown → exit → 必要时杀进程树）。 */
	shutdown(): Promise<void>;
	/** 直接杀进程树。 */
	kill(): Promise<void>;
}

export interface EndpointRequest {
	role: PoolRole;
	/** P2 每次 spawn 递增（从 1 开始）。 */
	epoch: number;
	/** `p1` / `p2:3`。 */
	namespace: string;
	workspaceUri: string;
}

export interface PoolEventMeta {
	role: PoolRole;
	namespace: string;
}

export interface RpcPoolOptions {
	/** `workspace/open` 用的工程目录 uri（`file://…`）。 */
	workspaceUri: string;
	createEndpoint: (request: EndpointRequest) => Promise<RpcEndpoint>;
	/** P2 空闲多久后回收。默认 60s；`<= 0` 表示不自动回收。 */
	p2IdleTimeoutMs?: number;
	/** P2 上拦截 `config/set` / `config/migrate`（默认 true）。 */
	guardEvaluationWrites?: boolean;
	/** 是否把 params 里的 `sessionId` 改写成目标进程自己的 session（默认 true）。 */
	rewriteSessionIds?: boolean;
	/** 端点创建后的回调（Doctor 记录 pid）。 */
	onEndpointReady?: (endpoint: RpcEndpoint) => void;
}

/** 默认 P2 空闲回收时间。 */
export const DEFAULT_P2_IDLE_TIMEOUT_MS = 60_000;

/** `run/*` 走评测面；其余（workspace/config/problem/ren）走控制面。 */
export function roleForMethod(method: string): PoolRole {
	return method.startsWith("run/") ? "p2" : "p1";
}

/** 给 id 加进程命名空间前缀（已带同前缀时原样返回）。 */
export function namespacedId(namespace: string, id: string): string {
	return id.startsWith(`${namespace}:`) ? id : `${namespace}:${id}`;
}

/**
 * 拆出命名空间前缀：`p1:12` → `{p1, 12}`；`p2:3:12` → `{p2:3, 12}`。
 * 以**最后一个**冒号切分，因此 `p2:<epoch>:<id>` 不会被切错。
 */
export function splitNamespacedId(id: string): { namespace: string; id: string } | undefined {
	const index = id.lastIndexOf(":");
	if (index <= 0 || index === id.length - 1) {
		return undefined;
	}
	return { namespace: id.slice(0, index), id: id.slice(index + 1) };
}

interface ActiveEndpoint {
	role: PoolRole;
	epoch: number;
	namespace: string;
	endpoint: RpcEndpoint;
	sessionId: SessionId;
	seq: SeqTracker;
	notifications: Disposable;
	idleTimer: NodeJS.Timeout | undefined;
	inFlight: number;
	disposed: boolean;
}

/**
 * 池中的一个端点视图：`call()` 会把 `run/create` / `ren/run` 返回的 id 加上命名空间前缀。
 */
export class PooledEndpoint {
	readonly role: PoolRole;
	readonly namespace: string;
	readonly sessionId: SessionId;
	readonly epoch: number;
	private readonly endpoint: RpcEndpoint;
	private readonly onCreated: (kind: StreamKind, namespacedId: string) => void;

	constructor(options: {
		role: PoolRole;
		namespace: string;
		sessionId: SessionId;
		epoch: number;
		endpoint: RpcEndpoint;
		onCreated: (kind: StreamKind, namespacedId: string) => void;
	}) {
		this.role = options.role;
		this.namespace = options.namespace;
		this.sessionId = options.sessionId;
		this.epoch = options.epoch;
		this.endpoint = options.endpoint;
		this.onCreated = options.onCreated;
	}

	get pid(): number | undefined {
		return this.endpoint.pid;
	}

	get alive(): boolean {
		return this.endpoint.alive;
	}

	get capabilities(): ReadonlySet<Capability> | undefined {
		return this.endpoint.capabilities;
	}

	/** 子进程 stderr 尾部（Doctor 用）。 */
	stderrTail(): string {
		return this.endpoint.stderrTail?.() ?? "";
	}

	async call<M extends MethodName>(method: M, params: MethodParams<M>, options?: RpcCallOptions): Promise<MethodResult<M>> {
		const result = await this.endpoint.call(method, params, options);
		const created = streamIdFromResult(method, result);
		if (!created) {
			return result;
		}
		const namespaced = namespacedId(this.namespace, created.id);
		this.onCreated(created.kind, namespaced);
		const patched =
			created.kind === "run"
				? { ...(result as Record<string, unknown>), runId: namespaced }
				: { ...(result as Record<string, unknown>), taskId: namespaced };
		logger.debug(`[pool] ${method} 创建 ${created.kind} ${namespaced}（进程 ${this.namespace}）`);
		return patched as MethodResult<M>;
	}
}

/**
 * 多进程 RPC 池。
 */
export class RpcPool {
	private readonly options: RpcPoolOptions;
	private readonly p2IdleTimeoutMs: number;
	private readonly guardWrites: boolean;
	private readonly rewriteSessionIds: boolean;

	private controlActive: ActiveEndpoint | undefined;
	private evaluationActive: ActiveEndpoint | undefined;
	private evaluationEpoch = 0;
	private controlPending: Promise<PooledEndpoint> | undefined;
	private evaluationPending: Promise<PooledEndpoint> | undefined;
	/** spawn 令牌：回收/释放会让在飞的 spawn 结果作废，避免刚生出来就泄漏。 */
	private controlSpawnToken = 0;
	private evaluationSpawnToken = 0;

	private readonly correlator = new EventCorrelator({
		onDrop: (event, reason) => {
			if (reason !== "flush") {
				logger.debug(`[pool] 丢弃早到事件 ${event.method}（${reason}）。`);
			}
		},
	});
	private readonly bus = new RpcEventBus();
	private disposed = false;

	constructor(options: RpcPoolOptions) {
		this.options = options;
		this.p2IdleTimeoutMs = options.p2IdleTimeoutMs ?? DEFAULT_P2_IDLE_TIMEOUT_MS;
		this.guardWrites = options.guardEvaluationWrites !== false;
		this.rewriteSessionIds = options.rewriteSessionIds !== false;
	}

	// ── 订阅 ────────────────────────────────────────────────────────────────
	onEvent(handler: (event: RpcEvent, meta: PoolEventMeta) => void): Disposable {
		return this.bus.on((event) => handler(event, this.metaForEvent(event)));
	}

	/** 按方法订阅（不带 meta）。 */
	onEventMethod<E extends RpcEvent["method"]>(
		method: E,
		handler: (event: Extract<RpcEvent, { method: E }>) => void,
	): Disposable {
		return this.bus.onMethod(method, handler);
	}

	// ── 端点获取 ────────────────────────────────────────────────────────────
	/** 控制面（P1）：常驻，首次调用时创建。 */
	control(): Promise<PooledEndpoint> {
		if (this.controlActive && !this.controlActive.disposed) {
			return Promise.resolve(this.wrap(this.controlActive));
		}
		if (!this.controlPending) {
			const token = ++this.controlSpawnToken;
			this.controlPending = this.spawn({ role: "p1", epoch: 0, namespace: "p1" }).then(async (active) => {
				if (this.disposed || token !== this.controlSpawnToken) {
					// dispose / 回收与端点创建竞态：刚生出来的进程必须立刻回收，不能泄漏。
					await this.discardSpawned(active);
					throw TuackRpcError.local(LocalErrorCode.TransportClosed, "端点创建期间进程池已被释放/回收，端点已回收。");
				}
				this.controlActive = active;
				this.controlPending = undefined;
				return this.wrap(active);
			});
			this.controlPending.catch(() => {
				this.controlPending = undefined;
			});
		}
		return this.controlPending;
	}

	/** 评测面（P2）：按需 spawn，每次 spawn 一个新命名空间（`p2:<epoch>`）。 */
	evaluation(): Promise<PooledEndpoint> {
		if (this.evaluationActive && !this.evaluationActive.disposed) {
			return Promise.resolve(this.wrap(this.evaluationActive));
		}
		if (!this.evaluationPending) {
			this.evaluationEpoch += 1;
			const epoch = this.evaluationEpoch;
			const token = ++this.evaluationSpawnToken;
			this.evaluationPending = this.spawn({ role: "p2", epoch, namespace: `p2:${epoch}` }).then(async (active) => {
				if (this.disposed || token !== this.evaluationSpawnToken) {
					// 评测被取消 / 已回收：把刚生出来的 P2 立刻杀掉，不留孤儿进程。
					await this.discardSpawned(active);
					throw TuackRpcError.local(LocalErrorCode.TransportClosed, "端点创建期间进程池已被释放/回收，端点已回收。");
				}
				this.evaluationActive = active;
				this.evaluationPending = undefined;
				return this.wrap(active);
			});
			this.evaluationPending.catch(() => {
				this.evaluationPending = undefined;
			});
		}
		return this.evaluationPending;
	}

	/** 回收一个刚创建、但池已经释放的端点。 */
	private async discardSpawned(active: ActiveEndpoint): Promise<void> {
		active.disposed = true;
		active.notifications.dispose();
		if (active.idleTimer) {
			clearTimeout(active.idleTimer);
			active.idleTimer = undefined;
		}
		try {
			await active.endpoint.shutdown();
		} catch {
			await active.endpoint.kill().catch(() => undefined);
		}
	}

	get controlEndpoint(): PooledEndpoint | undefined {
		return this.controlActive && !this.controlActive.disposed ? this.wrap(this.controlActive) : undefined;
	}

	get evaluationEndpoint(): PooledEndpoint | undefined {
		return this.evaluationActive && !this.evaluationActive.disposed ? this.wrap(this.evaluationActive) : undefined;
	}

	get hasEvaluation(): boolean {
		return this.evaluationActive !== undefined && !this.evaluationActive.disposed;
	}

	get currentEvaluationNamespace(): string | undefined {
		return this.evaluationEndpoint?.namespace;
	}

	get p2Epoch(): number {
		return this.evaluationEpoch;
	}

	controlSessionId(): SessionId | undefined {
		return this.controlEndpoint?.sessionId;
	}

	evaluationSessionId(): SessionId | undefined {
		return this.evaluationEndpoint?.sessionId;
	}

	/** 某个命名空间是否仍活在池里。 */
	isNamespaceAlive(namespace: string): boolean {
		return this.findActive(namespace) !== undefined;
	}

	/** 判断一个（可能带前缀的）id 是否属于当前活跃进程。 */
	isStreamAlive(kind: StreamKind, id: string): boolean {
		const split = splitNamespacedId(id);
		if (!split) {
			return kind === "run" ? this.hasEvaluation : this.controlEndpoint !== undefined;
		}
		const active = this.findActive(split.namespace);
		if (!active) {
			return false;
		}
		return kind === "run" ? active.role === "p2" : true;
	}

	// ── 调用 ────────────────────────────────────────────────────────────────
	/**
	 * 按方法自动选面：`run/*` → P2（必要时 spawn），其余 → P1。
	 * 带命名空间前缀的 `runId`/`taskId` 会覆盖自动选择并按前缀路由。
	 */
	call<M extends MethodName>(method: M, params: MethodParams<M>, options?: RpcCallOptions): Promise<MethodResult<M>> {
		return this.callOn(roleForMethod(method), method, params, options);
	}

	/** 显式指定面（`workspace/close` 之类需要精确控制的场景，以及测试）。 */
	async callOn<M extends MethodName>(
		role: PoolRole,
		method: M,
		params: MethodParams<M>,
		options?: RpcCallOptions,
	): Promise<MethodResult<M>> {
		if (this.disposed) {
			throw TuackRpcError.local(LocalErrorCode.TransportClosed, `进程池已释放，无法调用 ${method}。`);
		}

		// 1. 命名空间化的 id 参数决定路由。
		let explicit: ActiveEndpoint | undefined;
		let rewritten: unknown = params;
		if (params !== null && typeof params === "object") {
			const record = { ...(params as Record<string, unknown>) };
			for (const key of ["runId", "taskId"] as const) {
				const value = record[key];
				if (typeof value !== "string") {
					continue;
				}
				const split = splitNamespacedId(value);
				if (!split) {
					logger.debug(`[pool] ${method} 的 ${key}=${value} 没有命名空间前缀，按自动路由处理。`);
					continue;
				}
				const active = this.findActive(split.namespace);
				if (!active) {
					throw TuackRpcError.local(
						LocalErrorCode.ProcessExited,
						`${key}=${value} 属于已回收的进程 ${split.namespace}；该 run/task 只活在那个进程的内存里，无法恢复。`,
						{ method, id: value, namespace: split.namespace },
					);
				}
				explicit = active;
				record[key] = split.id;
			}
			rewritten = record;
		}

		// 2. 取端点。
		let internal: ActiveEndpoint;
		if (explicit) {
			internal = explicit;
		} else {
			internal = this.toActive(await (role === "p2" ? this.evaluation() : this.control()));
		}

		// 3. 硬纪律：P2 不能写配置。
		if ((method === "config/set" || method === "config/migrate") && internal.role === "p2") {
			const message =
				`在评测面（${internal.namespace}）上调用 ${method} 被拒绝：` +
				"revision 是进程级的，跨进程乐观并发不成立，写入会被静默丢失。配置只由控制面（P1）写。";
			if (this.guardWrites) {
				throw TuackRpcError.local(LocalErrorCode.RoleForbidden, message, { method, namespace: internal.namespace });
			}
			logger.warn(`[pool] ${message}（guardEvaluationWrites=false，已放行）`);
		}

		// 4. capabilities 门控。
		const required = capabilityForMethod(method);
		if (required && internal.endpoint.capabilities && !internal.endpoint.capabilities.has(required)) {
			throw TuackRpcError.local(
				LocalErrorCode.CapabilityUnavailable,
				`${internal.namespace} 未声明能力 ${required}，拒绝调用 ${method}。`,
				{ method, capability: required, capabilities: [...internal.endpoint.capabilities] },
			);
		}

		// 5. session 改写：session 是**进程级**的，跨进程传必然 -32001。
		if (this.rewriteSessionIds && rewritten !== null && typeof rewritten === "object" && "sessionId" in (rewritten as object)) {
			rewritten = { ...(rewritten as Record<string, unknown>), sessionId: internal.sessionId };
		}

		internal.inFlight += 1;
		try {
			return await this.wrap(internal).call(method, rewritten as MethodParams<M>, options);
		} finally {
			internal.inFlight -= 1;
			this.touchIdle(internal);
		}
	}

	// ── 回收 ────────────────────────────────────────────────────────────────
	/** 回收评测面（空闲到点或显式调用）。已经回收时是 no-op。 */
	async recycleEvaluation(reason = "manual"): Promise<void> {
		this.evaluationSpawnToken += 1;
		const active = this.evaluationActive;
		if (!active) {
			return;
		}
		this.evaluationActive = undefined;
		active.disposed = true;
		if (active.idleTimer) {
			clearTimeout(active.idleTimer);
			active.idleTimer = undefined;
		}
		active.notifications.dispose();

		const dropped = this.correlator.discardWhere((event) => {
			const id = streamIdOfEvent(event);
			return typeof id === "string" && id.startsWith(`${active.namespace}:`);
		});
		this.correlator.forgetNamespace(active.namespace);
		logger.info(
			`[pool] 回收评测面 ${active.namespace}（${reason}）` +
				(dropped > 0 ? `，丢弃 ${dropped} 条未归属事件` : ""),
		);

		try {
			await active.endpoint.shutdown();
		} catch (error) {
			logger.warn(`[pool] ${active.namespace} 优雅回收失败（改杀进程树）：${describe(error)}`);
			try {
				await active.endpoint.kill();
			} catch (killError) {
				logger.error(`[pool] ${active.namespace} 杀进程树失败：${describe(killError)}`);
			}
		}
	}

	/** 回收控制面（通常只在 dispose 时）。 */
	async recycleControl(reason = "manual"): Promise<void> {
		this.controlSpawnToken += 1;
		const active = this.controlActive;
		if (!active) {
			return;
		}
		this.controlActive = undefined;
		active.disposed = true;
		if (active.idleTimer) {
			clearTimeout(active.idleTimer);
			active.idleTimer = undefined;
		}
		active.notifications.dispose();
		logger.info(`[pool] 回收控制面 ${active.namespace}（${reason}）`);
		try {
			await active.endpoint.shutdown();
		} catch (error) {
			logger.warn(`[pool] ${active.namespace} 优雅回收失败（改杀进程树）：${describe(error)}`);
			await active.endpoint.kill().catch(() => undefined);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		await this.recycleEvaluation("dispose");
		await this.recycleControl("dispose");
		const leftovers = this.correlator.flush();
		if (leftovers.length > 0) {
			logger.debug(`[pool] 释放时仍有 ${leftovers.length} 条早到事件未归属。`);
		}
		this.correlator.clear();
		this.bus.dispose();
	}

	// ── 内部 ────────────────────────────────────────────────────────────────

	private async spawn(request: Omit<EndpointRequest, "workspaceUri">): Promise<ActiveEndpoint> {
		const endpoint = await this.options.createEndpoint({ ...request, workspaceUri: this.options.workspaceUri });
		const active: ActiveEndpoint = {
			role: request.role,
			epoch: request.epoch,
			namespace: request.namespace,
			endpoint,
			sessionId: endpoint.sessionId,
			seq: new SeqTracker(),
			notifications: toDisposable(() => undefined),
			idleTimer: undefined,
			inFlight: 0,
			disposed: false,
		};
		active.notifications = endpoint.onNotification((message) => this.handleNotification(active, message));
		logger.info(
			`[pool] ${request.namespace} 就绪（pid=${endpoint.pid ?? "?"}，session=${endpoint.sessionId}，` +
				`capabilities=[${[...(endpoint.capabilities ?? [])].join(", ")}]）`,
		);
		this.options.onEndpointReady?.(endpoint);
		if (request.role === "p2") {
			this.touchIdle(active);
		}
		return active;
	}

	private handleNotification(active: ActiveEndpoint, message: RpcNotification): void {
		if (!isKnownEvent(message.method)) {
			// 硬要求：未知事件只记日志。tuack-ng 新增事件不应让客户端崩或报错。
			logger.debug(`[pool] ${active.namespace} 发来未知事件 ${message.method}，已忽略。`);
			return;
		}
		// 通知的负载在 params 里，先摊平成逻辑事件（protocol.ts 的 RpcEvent 是扁平形态）。
		const event = this.namespacify(active, toRpcEvent(message));
		const previous = active.seq.lastSeq;
		const health = active.seq.observe(event.seq);
		if (health.gap) {
			logger.warn(
				`[pool] ${active.namespace} 的事件序列出现缺口：跳过 ${health.missed} 条（seq ${previous} → ${event.seq}）。`,
			);
		}
		if (this.correlator.route(event)) {
			this.deliver(active, event);
		} else {
			logger.trace(`[pool] ${active.namespace} 的 ${event.method} 暂时无法归属（id 未登记），先缓冲。`);
		}
	}

	/** 给事件里的 `runId`/`taskId` 加进程前缀（`sessionId` 保持原样，它本来就是进程级的）。 */
	private namespacify(active: ActiveEndpoint, event: RpcEvent): RpcEvent {
		const id = streamIdOfEvent(event);
		if (typeof id !== "string" || id.startsWith(`${active.namespace}:`)) {
			return event;
		}
		const namespaced = namespacedId(active.namespace, id);
		return { ...event, ...(streamKindOfMethod(event.method) === "run" ? { runId: namespaced } : { taskId: namespaced }) } as RpcEvent;
	}

	private deliver(active: ActiveEndpoint, event: RpcEvent): void {
		this.bus.emit(event);
		if (event.method === "run/finished" || event.method === "ren/finished") {
			const kind = streamKindOfMethod(event.method);
			const id = streamIdOfEvent(event);
			if (kind && typeof id === "string") {
				// 终态之后再来的同 id 事件没有意义；遗忘以免 known 集合无界增长。
				this.correlator.forget(kind, id);
			}
		}
		this.touchIdle(active);
	}

	private metaForEvent(event: RpcEvent): PoolEventMeta {
		const id = streamIdOfEvent(event);
		const namespace = typeof id === "string" ? splitNamespacedId(id)?.namespace : undefined;
		if (namespace) {
			return { role: namespace.startsWith("p2") ? "p2" : "p1", namespace };
		}
		return { role: "p1", namespace: this.controlActive?.namespace ?? "p1" };
	}

	private touchIdle(active: ActiveEndpoint): void {
		if (active.role !== "p2" || this.p2IdleTimeoutMs <= 0 || active.disposed) {
			return;
		}
		if (active.idleTimer) {
			clearTimeout(active.idleTimer);
		}
		active.idleTimer = setTimeout(() => {
			if (active.disposed) {
				return;
			}
			if (active.inFlight > 0) {
				// 有请求在飞（可能是长时间的 run/judge），不能回收。
				this.touchIdle(active);
				return;
			}
			void this.recycleEvaluation("idle");
		}, this.p2IdleTimeoutMs);
	}

	private wrap(active: ActiveEndpoint): PooledEndpoint {
		return new PooledEndpoint({
			role: active.role,
			namespace: active.namespace,
			sessionId: active.sessionId,
			epoch: active.epoch,
			endpoint: active.endpoint,
			onCreated: (kind, id) => this.recognizeStream(active, kind, id),
		});
	}

	private toActive(endpoint: PooledEndpoint): ActiveEndpoint {
		const active = this.findActive(endpoint.namespace);
		if (!active) {
			throw TuackRpcError.local(
				LocalErrorCode.ProcessExited,
				`端点 ${endpoint.namespace} 已不在池中（可能刚被回收）。`,
				{ namespace: endpoint.namespace },
			);
		}
		return active;
	}

	private findActive(namespace: string): ActiveEndpoint | undefined {
		if (this.controlActive && !this.controlActive.disposed && this.controlActive.namespace === namespace) {
			return this.controlActive;
		}
		if (this.evaluationActive && !this.evaluationActive.disposed && this.evaluationActive.namespace === namespace) {
			return this.evaluationActive;
		}
		return undefined;
	}

	/** 新 id 被创建：回放该 id 早到的事件。 */
	private recognizeStream(active: ActiveEndpoint, kind: StreamKind, id: string): void {
		const replay = this.correlator.recognize(kind, id);
		for (const event of replay) {
			this.deliver(active, event);
		}
	}
}

function describe(error: unknown): string {
	if (error instanceof TuackRpcError) {
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实进程端点工厂（组合 process.ts + client.ts）
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcessEndpointFactoryOptions {
	/** 已由 `core/binaries.ts` 解析出的绝对路径。 */
	command: string;
	args?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	clientName?: string;
	clientVersion?: string;
	defaultTimeoutMs?: number;
	initializeTimeoutMs?: number;
	/** 秒退诊断里要列出的 assets 目录（来自 `core/assets.ts`）。 */
	probedAssetsDirs?: readonly string[];
	/** P2 启动后显式 `config/reload`（设计 §3.3：消除快照陈旧）。默认 true。 */
	reloadConfigOnEvaluation?: boolean;
	onStderr?: (namespace: string, text: string) => void;
	onExit?: (namespace: string, info: RpcExitInfo) => void;
}

/**
 * 用真实子进程创建端点：spawn → `initialize` → `workspace/open`（P2 再 `config/reload`）。
 * 失败时保证把刚 spawn 的进程杀干净，不留孤儿。
 */
export function createProcessEndpointFactory(
	options: ProcessEndpointFactoryOptions,
): (request: EndpointRequest) => Promise<RpcEndpoint> {
	return async (request: EndpointRequest): Promise<RpcEndpoint> => {
		const child = spawnRpcProcess({
			command: options.command,
			args: options.args,
			cwd: options.cwd,
			env: options.env,
			clientName: options.clientName,
			clientVersion: options.clientVersion,
			defaultTimeoutMs: options.defaultTimeoutMs,
			initializeTimeoutMs: options.initializeTimeoutMs,
			probedAssetsDirs: options.probedAssetsDirs,
			onStderr: (text) => options.onStderr?.(request.namespace, text),
			onExit: (info) => options.onExit?.(request.namespace, info),
		});

		try {
			await child.client.initialize();
			const opened = await child.client.call("workspace/open", { uri: request.workspaceUri });
			if (request.role === "p2" && options.reloadConfigOnEvaluation !== false) {
				if (opened.contest) {
					try {
						await child.client.call("config/reload", { sessionId: opened.sessionId });
					} catch (error) {
						// reload 失败不致命：run/create 自己会重新读盘。
						logger.warn(`[pool] ${request.namespace} config/reload 失败（继续）：${describe(error)}`);
					}
				} else {
					logger.debug(`[pool] ${request.namespace} 未识别到竞赛工程，跳过 config/reload。`);
				}
			}
			if (!opened.contest) {
				logger.warn(`[pool] ${request.namespace} workspace/open 未识别到竞赛工程（contest=null）。`);
			}
			return createProcessEndpoint(request, child, opened.sessionId);
		} catch (error) {
			logger.error(`[pool] ${request.namespace} 启动失败：${describe(error)}`);
			try {
				await child.dispose({ graceful: false, timeoutMs: 3000 });
			} catch {
				// 已经在退出路径上了。
			}
			throw asRpcError(error);
		}
	};
}

/** 把 `RpcProcess` 包成池可用的 `RpcEndpoint`。 */
export function createProcessEndpoint(request: EndpointRequest, child: RpcProcess, sessionId: SessionId): RpcEndpoint {
	const endpoint: RpcEndpoint = {
		role: request.role,
		namespace: request.namespace,
		sessionId,
		pid: child.pid,
		stderrTail: () => child.stderrText,
		get capabilities(): ReadonlySet<Capability> | undefined {
			return child.client.capabilities;
		},
		get alive(): boolean {
			return child.isRunning && child.client.state !== "dead";
		},
		call: <M extends MethodName>(method: M, params: MethodParams<M>, options?: RpcCallOptions) =>
			child.client.call(method, params, options),
		onNotification: (handler) => child.client.onNotification(handler),
		shutdown: async (): Promise<void> => {
			await child.dispose();
		},
		kill: async (): Promise<void> => {
			await child.kill();
		},
	};
	return endpoint;
}

/** 便于调用方处理的「run 已随进程消失」判定。 */
export function isRunGoneError(error: unknown): boolean {
	return (
		error instanceof TuackRpcError &&
		(error.code === ErrorCode.RunNotFound || error.code === LocalErrorCode.ProcessExited || error.code === LocalErrorCode.TransportClosed)
	);
}
