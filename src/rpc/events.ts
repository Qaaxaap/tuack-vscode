/**
 * 事件路由：把 `run/*`、`ren/*` 通知送到正确的地方。不碰进程与网络，纯逻辑，便于单测。
 *
 * 事件可能早于响应：`run/create` 会先发 `run/started` 再回 `runId`，所以认不出的 id 要先缓冲，
 * 等 id 被登记（响应到达或池层 recognize）后按到达顺序回放。`seq` 是进程级单调递增，缺口说明丢了事件。
 */

import {
	KNOWN_EVENT_METHODS,
	isKnownEvent,
	type Capability,
	type RpcEvent,
	type RpcEventMethod,
	type RpcNotification,
} from "./protocol";
import { logger } from "../core/log";

/** 最小可释放句柄（与 VS Code 的 `Disposable` 结构兼容）。 */
export interface Disposable {
	dispose(): void;
}

export function toDisposable(dispose: () => void): Disposable {
	return { dispose };
}

/** 事件流向哪条业务线：`run/*` 还是 `ren/*`。 */
export type StreamKind = "run" | "ren";

export function isRunEvent(event: RpcEvent): event is Extract<RpcEvent, { runId: string }> {
	return event.method.startsWith("run/");
}

export function isRenEvent(event: RpcEvent): event is Extract<RpcEvent, { taskId: string }> {
	return event.method.startsWith("ren/");
}

/** 由事件方法名判断流类型；未知方法返回 `undefined`。 */
export function streamKindOfMethod(method: string): StreamKind | undefined {
	if (method.startsWith("run/")) {
		return "run";
	}
	if (method.startsWith("ren/")) {
		return "ren";
	}
	return undefined;
}

/** 取事件的所属 id（`runId` 或 `taskId`）。 */
export function streamIdOfEvent(event: RpcEvent): string | undefined {
	if (isRunEvent(event)) {
		return event.runId;
	}
	if (isRenEvent(event)) {
		return event.taskId;
	}
	return undefined;
}

/** 由「创建型方法」的响应结果里取出新登记的 id。 */
export function streamIdFromResult(method: string, result: unknown): { kind: StreamKind; id: string } | null {
	if (typeof result !== "object" || result === null) {
		return null;
	}
	const record = result as Record<string, unknown>;
	if (method === "run/create" && typeof record["runId"] === "string") {
		return { kind: "run", id: record["runId"] };
	}
	if (method === "ren/run" && typeof record["taskId"] === "string") {
		return { kind: "ren", id: record["taskId"] };
	}
	return null;
}

/**
 * `seq` 缺口检测（每个进程一个实例）。`seq` 从 1 开始，`observe` 返回是否缺口以及跳过了多少；
 * 缺口只记日志：事件缺失没法用 RPC 错误表达，最终结论来自 `run/judge` 的响应，不依赖事件完整性。
 */
export class SeqTracker {
	private last = 0;
	private gapCount = 0;

	observe(seq: number): { first: boolean; gap: boolean; missed: number } {
		const first = this.last === 0;
		let gap = false;
		let missed = 0;
		if (!first && seq > this.last + 1) {
			gap = true;
			missed = seq - this.last - 1;
			this.gapCount += 1;
		}
		if (seq > this.last) {
			this.last = seq;
		}
		return { first, gap, missed };
	}

	get lastSeq(): number {
		return this.last;
	}

	get gaps(): number {
		return this.gapCount;
	}

	reset(): void {
		this.last = 0;
		this.gapCount = 0;
	}
}

/**
 * 事件订阅总线：同一批事件可以既有全部事件的订阅者，也有按方法的订阅者。单个订阅者抛错不影响其它订阅者。
 */
export class RpcEventBus {
	private readonly all = new Set<(event: RpcEvent) => void>();
	private readonly byMethod = new Map<RpcEventMethod, Set<(event: RpcEvent) => void>>();

	on(handler: (event: RpcEvent) => void): Disposable {
		this.all.add(handler);
		return toDisposable(() => this.all.delete(handler));
	}

	onMethod<E extends RpcEventMethod>(method: E, handler: (event: Extract<RpcEvent, { method: E }>) => void): Disposable {
		let set = this.byMethod.get(method);
		if (!set) {
			set = new Set();
			this.byMethod.set(method, set);
		}
		const wrapped = handler as (event: RpcEvent) => void;
		set.add(wrapped);
		return toDisposable(() => {
			set.delete(wrapped);
			if (set.size === 0) {
				this.byMethod.delete(method);
			}
		});
	}

	emit(event: RpcEvent): void {
		for (const handler of this.all) {
			safeInvoke(handler, event);
		}
		const methodHandlers = this.byMethod.get(event.method);
		if (methodHandlers) {
			for (const handler of methodHandlers) {
				safeInvoke(handler, event);
			}
		}
	}

	get listenerCount(): number {
		let count = this.all.size;
		for (const set of this.byMethod.values()) {
			count += set.size;
		}
		return count;
	}

	dispose(): void {
		this.all.clear();
		this.byMethod.clear();
	}
}

function safeInvoke(handler: (event: RpcEvent) => void, event: RpcEvent): void {
	try {
		handler(event);
	} catch (error) {
		logger.error(`[rpc] 事件订阅者抛错（${event.method}）：${error instanceof Error ? error.message : String(error)}`);
	}
}

export interface EventCorrelatorOptions {
	/** 未登记 id 的事件最多缓冲多少条（超出丢最旧的）。 */
	maxBufferedEvents?: number;
	/** 缓冲溢出时回调。 */
	onDrop?: (event: RpcEvent, reason: "overflow" | "discard" | "flush") => void;
}

/** 默认缓冲上限：一次 run 的事件量远小于此，仅防泄漏。 */
export const DEFAULT_MAX_BUFFERED_EVENTS = 4096;

/**
 * 未登记 id 的事件缓冲器。`route(event)` 返回 `true` 表示 id 已登记可直接投递，`false` 表示已缓冲；
 * 新 id 被创建时（`run/create` / `ren/run` 的响应，或池层显式登记）调 `recognize(kind, id)` 取回要回放的事件。
 */
export class EventCorrelator {
	private readonly known = new Set<string>();
	private readonly buffered: RpcEvent[] = [];
	private readonly maxBuffered: number;
	private readonly onDrop: ((event: RpcEvent, reason: "overflow" | "discard" | "flush") => void) | undefined;

	constructor(options: EventCorrelatorOptions = {}) {
		this.maxBuffered = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
		this.onDrop = options.onDrop;
	}

	private static key(kind: StreamKind, id: string): string {
		return `${kind}\u0000${id}`;
	}

	private static eventKey(event: RpcEvent): string | undefined {
		const kind = streamKindOfMethod(event.method);
		const id = streamIdOfEvent(event);
		return kind && id !== undefined ? EventCorrelator.key(kind, id) : undefined;
	}

	/** id 是否已登记。 */
	isKnown(kind: StreamKind, id: string): boolean {
		return this.known.has(EventCorrelator.key(kind, id));
	}

	/** 登记一个 id，并返回该 id 已缓冲的事件（按到达顺序，缓冲队列中删除）。 */
	recognize(kind: StreamKind, id: string): RpcEvent[] {
		this.known.add(EventCorrelator.key(kind, id));
		const key = EventCorrelator.key(kind, id);
		const replay: RpcEvent[] = [];
		for (let i = this.buffered.length - 1; i >= 0; i -= 1) {
			const event = this.buffered[i];
			if (event && EventCorrelator.eventKey(event) === key) {
				replay.unshift(event);
				this.buffered.splice(i, 1);
			}
		}
		if (replay.length > 0) {
			logger.debug(`[rpc] 回放 ${replay.length} 条早到事件（${kind}:${id}）。`);
		}
		return replay;
	}

	/** 路由一条事件：已登记返回 `true`，否则缓冲后返回 `false`。 */
	route(event: RpcEvent): boolean {
		const key = EventCorrelator.eventKey(event);
		if (key === undefined) {
			return true;
		}
		if (this.known.has(key)) {
			return true;
		}
		this.buffered.push(event);
		if (this.buffered.length > this.maxBuffered) {
			const dropped = this.buffered.shift();
			if (dropped) {
				logger.warn(`[rpc] 早到事件缓冲已满（${this.maxBuffered}），丢弃最旧的一条：${dropped.method}`);
				this.onDrop?.(dropped, "overflow");
			}
		}
		return false;
	}

	/** 取走剩余缓冲，不清空 known。 */
	flush(): RpcEvent[] {
		const all = this.buffered.splice(0, this.buffered.length);
		for (const event of all) {
			this.onDrop?.(event, "flush");
		}
		return all;
	}

	/** 丢弃满足条件的事件。 */
	discardWhere(predicate: (event: RpcEvent) => boolean): number {
		let removed = 0;
		for (let i = this.buffered.length - 1; i >= 0; i -= 1) {
			const event = this.buffered[i];
			if (event && predicate(event)) {
				this.buffered.splice(i, 1);
				removed += 1;
				this.onDrop?.(event, "discard");
			}
		}
		return removed;
	}

	/** 遗忘一个 id，避免 known 集合无界增长。 */
	forget(kind: StreamKind, id: string): void {
		this.known.delete(EventCorrelator.key(kind, id));
	}

	/** 遗忘所有属于某个进程命名空间（`<namespace>:<id>`）的登记项：进程回收时用。 */
	forgetNamespace(namespace: string): number {
		const marker = `\u0000${namespace}:`;
		let removed = 0;
		for (const key of [...this.known]) {
			if (key.includes(marker)) {
				this.known.delete(key);
				removed += 1;
			}
		}
		return removed;
	}

	get bufferedCount(): number {
		return this.buffered.length;
	}

	get knownCount(): number {
		return this.known.size;
	}

	clear(): void {
		this.buffered.length = 0;
		this.known.clear();
	}
}

/**
 * 已知事件方法名集合的再导出（定义在 `protocol.ts`）。收到未知事件方法只记日志、不报错。
 */

/**
 * 把 JSON-RPC 通知映射成逻辑事件。线上是标准通知（`method` + `params`），
 * 而 `RpcEvent` 是扁平形态（`method` 与事件字段同一层）；`params` 缺失或不是对象时退化成整条信封即负载。
 */
export function toRpcEvent(notification: RpcNotification): RpcEvent {
	const params = notification.params;
	const payload =
		typeof params === "object" && params !== null && !Array.isArray(params)
			? (params as Record<string, unknown>)
			: (notification as unknown as Record<string, unknown>);
	return { ...payload, method: notification.method } as unknown as RpcEvent;
}

export function classifyNotification(message: RpcNotification): { kind: "event"; event: RpcEvent } | { kind: "unknown"; method: string } {
	if (isKnownEvent(message.method)) {
		return { kind: "event", event: toRpcEvent(message) };
	}
	return { kind: "unknown", method: message.method };
}

/** 已知事件方法名。 */
export const KNOWN_EVENT_METHOD_NAMES: readonly RpcEventMethod[] = KNOWN_EVENT_METHODS;

/**
 * 方法所需的 capability（`initialize` / `shutdown` / `exit` 不需要）。调用未声明的方法前先用这张表校验。
 */
export function capabilityForMethod(method: string): Capability | undefined {
	if (method === "initialize" || method === "shutdown" || method === "exit") {
		return undefined;
	}
	const head = method.split("/")[0];
	switch (head) {
		case "workspace":
			return "workspace";
		case "config":
			return "config";
		case "problem":
			return "problem";
		case "run":
			return "run";
		case "ren":
			return "ren";
		default:
			return undefined;
	}
}
