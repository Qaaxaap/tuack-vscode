/**
 * 单进程 RPC 客户端：id 分配、pending 表、超时、通知分发、错误转换。不含 spawn（core/process.ts）与多进程路由（pool.ts）。
 *
 * id 永不复用，晚到的同 id 响应一律丢弃，否则会错配给后续请求；不做隐式重试（run/judge 这类同步 handler 会阻塞读循环）。
 * 未知通知只记日志；生命周期强制 initialize 先行、shutdown 后只能 exit，要绕开用 rawCall()。
 */

import {
	ErrorCode,
	isNotification,
	isResponse,
	type Capability,
	type InitializeResult,
	type MethodName,
	type MethodParams,
	type MethodResult,
	type RpcEvent,
	type RpcNotification,
	type RpcRequest,
	type RequestId,
} from "./protocol";
import { LocalErrorCode, TuackRpcError, asRpcError } from "./errors";
import type { NdjsonTransport } from "./transport";
import { capabilityForMethod, classifyNotification, toDisposable, type Disposable } from "./events";
import { logger } from "../core/log";

/** 默认请求超时。`run/judge` 请显式传更长超时（单点最长 = 该点时限）。 */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
/** `initialize` 默认超时。 */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 20_000;
/** `shutdown` 默认超时。 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export type RpcClientState = "idle" | "ready" | "closed" | "dead";

export interface RpcCallOptions {
	/** 覆盖默认超时；`<= 0` 表示不设超时。 */
	timeoutMs?: number;
	/** 主动取消。 */
	signal?: AbortSignal;
}

export interface RpcClientOptions {
	transport: NdjsonTransport;
	/** `initialize` 里的 clientInfo.name。 */
	clientName?: string;
	clientVersion?: string;
	defaultTimeoutMs?: number;
	initializeTimeoutMs?: number;
	shutdownTimeoutMs?: number;
	/** 是否用 `initialize` 返回的 capabilities 门控调用（默认 true，关闭后只记 warn 不拦）。 */
	enforceCapabilities?: boolean;
	/** 是否强制 `initialize` 先行、`shutdown` 后拒发（默认 true）。 */
	enforceLifecycle?: boolean;
	/** 服务端发来无 pending 对应的 `error`（id 为 null）时回调。 */
	onServerError?: (error: TuackRpcError) => void;
	/** 收到无法归类的消息（协议违规）时回调。 */
	onProtocolViolation?: (detail: string, raw: unknown) => void;
}

interface PendingCall {
	method: string;
	key: string;
	id: RequestId;
	startedAt: number;
	timer: NodeJS.Timeout | undefined;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	cleanupAbort: (() => void) | undefined;
}

function idKey(id: RequestId): string {
	return `${typeof id}:${id}`;
}

/** 待决请求快照。 */
export interface PendingCallInfo {
	id: RequestId;
	method: string;
	elapsedMs: number;
}

/**
 * 单个 `tuack-ng-rpc` 进程的 JSON-RPC 客户端。
 */
export class RpcClient {
	private readonly transport: NdjsonTransport;
	private readonly options: RpcClientOptions;
	private readonly pending = new Map<string, PendingCall>();
	private readonly notificationHandlers = new Set<(message: RpcNotification) => void>();
	private readonly eventHandlers = new Set<(event: RpcEvent) => void>();

	private nextId = 1;
	private stateValue: RpcClientState = "idle";
	private initializePromise: Promise<InitializeResult> | undefined;
	private initializeResult: InitializeResult | undefined;
	private capabilitiesValue: ReadonlySet<Capability> | undefined;
	private lastError: TuackRpcError | undefined;

	constructor(options: RpcClientOptions) {
		this.options = options;
		this.transport = options.transport;
	}

	// ── 状态 ────────────────────────────────────────────────────────────────
	get state(): RpcClientState {
		return this.stateValue;
	}

	get isAlive(): boolean {
		return this.stateValue === "idle" || this.stateValue === "ready";
	}

	get capabilities(): ReadonlySet<Capability> | undefined {
		return this.capabilitiesValue;
	}

	get serverInfo(): InitializeResult["serverInfo"] | undefined {
		return this.initializeResult?.serverInfo;
	}

	get protocolVersion(): string | undefined {
		return this.initializeResult?.protocolVersion;
	}

	/** 最近一次失败。 */
	get recentError(): TuackRpcError | undefined {
		return this.lastError;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	pendingCalls(): PendingCallInfo[] {
		const now = Date.now();
		return [...this.pending.values()].map((call) => ({
			id: call.id,
			method: call.method,
			elapsedMs: now - call.startedAt,
		}));
	}

	/** 该方法的 capability 是否被服务端声明（未 initialize 时返回 true，交由超时处理）。 */
	supports(method: string): boolean {
		const required = capabilityForMethod(method);
		if (!required || !this.capabilitiesValue) {
			return true;
		}
		return this.capabilitiesValue.has(required);
	}

	// ── 订阅 ────────────────────────────────────────────────────────────────
	/** 订阅所有通知（含未知事件方法）。 */
	onNotification(handler: (message: RpcNotification) => void): Disposable {
		this.notificationHandlers.add(handler);
		return toDisposable(() => this.notificationHandlers.delete(handler));
	}

	/** 订阅已知事件（`run/*`、`ren/*`），已按类型收窄。 */
	onEvent(handler: (event: RpcEvent) => void): Disposable {
		this.eventHandlers.add(handler);
		return toDisposable(() => this.eventHandlers.delete(handler));
	}

	// ── 调用 ────────────────────────────────────────────────────────────────
	/**
	 * 发一个类型化请求。失败一律以 `TuackRpcError` 拒绝（生命周期违规、能力缺失、超时、
	 * 传输关闭、进程退出、服务端错误），`code` 保留服务端或本地错误码。
	 */
	call<M extends MethodName>(method: M, params: MethodParams<M>, options?: RpcCallOptions): Promise<MethodResult<M>> {
		return this.rawCall(method, params, options) as Promise<MethodResult<M>>;
	}

	/**
	 * 未类型化的请求（`exit`、未来新方法）。不做 capabilities 门控，但关闭或死亡时仍拒绝。
	 */
	rawCall(method: string, params?: unknown, options?: RpcCallOptions): Promise<unknown> {
		// 协议：shutdown 之后只能 exit（或关 stdin），所以 exit 是 closed 状态下的唯一例外。
		if (this.stateValue === "dead" || (this.stateValue === "closed" && method !== "exit")) {
			return Promise.reject(this.closedError(method));
		}
		if (
			this.options.enforceLifecycle !== false &&
			method !== "initialize" &&
			method !== "exit" &&
			this.stateValue !== "ready"
		) {
			return Promise.reject(
				TuackRpcError.local(
					LocalErrorCode.LifecycleViolation,
					`在 initialize 完成前调用 ${method}（协议要求 initialize 先行）。`,
					{ method, state: this.stateValue },
				),
			);
		}
		const required = capabilityForMethod(method);
		if (required && this.capabilitiesValue && !this.capabilitiesValue.has(required)) {
			const error = TuackRpcError.local(
				LocalErrorCode.CapabilityUnavailable,
				`服务端未声明能力 ${required}，拒绝调用 ${method}。`,
				{ method, capability: required, capabilities: [...this.capabilitiesValue] },
			);
			if (this.options.enforceCapabilities === false) {
				logger.warn(error.message);
			} else {
				this.lastError = error;
				return Promise.reject(error);
			}
		}

		const id = this.nextId;
		this.nextId += 1;
		const key = idKey(id);
		const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

		return new Promise<unknown>((resolve, reject) => {
			const call: PendingCall = {
				method,
				key,
				id,
				startedAt: Date.now(),
				timer: undefined,
				resolve,
				reject,
				cleanupAbort: undefined,
			};

			if (timeoutMs > 0) {
				call.timer = setTimeout(() => {
					if (this.pending.delete(key)) {
						const error = TuackRpcError.local(
							LocalErrorCode.Timeout,
							`请求 ${method}（id=${id}）在 ${timeoutMs}ms 内没有响应。`,
							{ method, id, timeoutMs },
						);
						this.lastError = error;
						logger.warn(`[rpc] ${error.message}`);
						reject(error);
					}
				}, timeoutMs);
			}

			if (options?.signal) {
				const signal = options.signal;
				if (signal.aborted) {
					this.rejectPending(call, abortError(method, id));
					return;
				}
				const onAbort = (): void => {
					if (this.pending.delete(key)) {
						this.rejectPending(call, abortError(method, id));
					}
				};
				signal.addEventListener("abort", onAbort, { once: true });
				call.cleanupAbort = () => signal.removeEventListener("abort", onAbort);
			}

			this.pending.set(key, call);

			const request: RpcRequest = { jsonrpc: "2.0", id, method };
			if (params !== undefined) {
				(request as { params?: unknown }).params = params;
			}
			try {
				logger.trace(`[rpc] → ${method} (id=${id})`);
				this.transport.writeValue(request);
			} catch (error) {
				this.pending.delete(key);
				const wrapped = asRpcError(error, LocalErrorCode.TransportClosed);
				this.lastError = wrapped;
				this.rejectPending(call, wrapped);
			}
		});
	}

	/** 发通知（无 id，不等响应）。协议目前没有客户端到服务端的通知，留给未来扩展/诊断。 */
	notify(method: string, params?: unknown): void {
		if (this.stateValue === "closed" || this.stateValue === "dead") {
			throw this.closedError(method);
		}
		const notification: RpcNotification = { jsonrpc: "2.0", method };
		if (params !== undefined) {
			(notification as { params?: unknown }).params = params;
		}
		this.transport.writeValue(notification);
	}

	/**
	 * `initialize`：幂等，失败后不重试（同一个 Promise）；成功后记下 capabilities / serverInfo 并进入 `ready`。
	 */
	initialize(options?: RpcCallOptions): Promise<InitializeResult> {
		if (this.initializePromise) {
			return this.initializePromise;
		}
		const params = {
			clientInfo: {
				name: this.options.clientName ?? "tuack-vscode",
				version: this.options.clientVersion ?? "0.0.0",
			},
		};
		this.initializePromise = this.call("initialize", params, {
			timeoutMs: options?.timeoutMs ?? this.options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
			signal: options?.signal,
		})
			.then((result) => {
				this.initializeResult = result;
				this.capabilitiesValue = new Set(result.capabilities ?? []);
				this.stateValue = "ready";
				logger.info(
					`[rpc] initialize 完成：${result.serverInfo?.name ?? "?"} ${result.serverInfo?.version ?? "?"}，` +
						`protocol ${result.protocolVersion}，capabilities=[${[...this.capabilitiesValue].join(", ")}]`,
				);
				return result;
			})
			.catch((error: unknown) => {
				const wrapped = asRpcError(error);
				this.lastError = wrapped;
				throw wrapped;
			});
		return this.initializePromise;
	}

	/** `shutdown`：成功后客户端进入 `closed`（此后只能 `exit` / 关 stdin）。 */
	async shutdown(options?: RpcCallOptions): Promise<void> {
		if (this.stateValue === "closed" || this.stateValue === "dead") {
			return;
		}
		try {
			await this.call("shutdown", undefined, {
				timeoutMs: options?.timeoutMs ?? this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
				signal: options?.signal,
			});
		} finally {
			this.stateValue = "closed";
		}
	}

	/**
	 * 传输或进程已死：拒绝所有 pending（幂等）。core/process.ts 在子进程 close 时调用，
	 * 把秒退与 stderr 诊断带给等待中的调用方，而不是让 UI 干等到 initialize 超时。
	 */
	fail(error: TuackRpcError): void {
		if (this.stateValue === "dead" || this.stateValue === "closed") {
			this.rejectAll(error);
			return;
		}
		this.lastError = error;
		this.stateValue = "dead";
		this.rejectAll(error);
	}

	/** 主动释放（不杀进程）：拒绝 pending 并摘掉订阅。 */
	dispose(reason = "客户端已释放。"): void {
		if (this.stateValue !== "dead") {
			this.stateValue = "closed";
		}
		this.rejectAll(TuackRpcError.local(LocalErrorCode.TransportClosed, reason));
		this.notificationHandlers.clear();
		this.eventHandlers.clear();
	}

	// ── 入站消息 ────────────────────────────────────────────────────────────
	/** 由 core/process.ts 接在 transport 上。 */
	readonly handleMessage = (message: unknown): void => {
		if (isResponse(message)) {
			this.handleResponse(message);
			return;
		}
		if (isNotification(message)) {
			this.handleNotification(message);
			return;
		}
		const detail = "收到既不是响应也不是通知的消息（协议违规）。";
		logger.warn(`[rpc] ${detail}`);
		this.options.onProtocolViolation?.(detail, message);
	};

	private handleResponse(message: { id: RequestId | null; result?: unknown; error?: unknown }): void {
		const id = message.id;
		if (id === null) {
			// 服务端解析请求失败时会用 id:null 回错误，没有 pending 可对应。
			const failure = message as { error?: { code: number; message: string; data?: unknown } };
			const error = failure.error
				? TuackRpcError.fromFailure({ jsonrpc: "2.0", id: null, error: failure.error })
				: TuackRpcError.local(ErrorCode.ParseError, "服务端返回 id:null 的响应，但没有 error 字段。");
			this.lastError = error;
			logger.error(`[rpc] 服务端错误（无请求上下文）：${error.message}`);
			this.options.onServerError?.(error);
			return;
		}

		const key = idKey(id);
		const call = this.pending.get(key);
		if (!call) {
			// 迟到的响应：id 永不复用，所以这里只能是超时/死亡后的残留。
			logger.warn(`[rpc] 收到无 pending 对应的响应（id=${String(id)}），已忽略（迟到或重复响应）。`);
			return;
		}
		this.pending.delete(key);
		if (call.timer) {
			clearTimeout(call.timer);
		}
		call.cleanupAbort?.();

		if ("error" in message && message.error) {
			const error = TuackRpcError.fromFailure({
				jsonrpc: "2.0",
				id,
				error: message.error as { code: number; message: string; data?: unknown },
			});
			this.lastError = error;
			logger.debug(`[rpc] ← ${call.method} (id=${id}) 失败：${error.message}`);
			call.reject(error);
			return;
		}
		logger.trace(`[rpc] ← ${call.method} (id=${id}) 成功（${Date.now() - call.startedAt}ms）`);
		call.resolve((message as { result?: unknown }).result);
	}

	private handleNotification(message: RpcNotification): void {
		const classified = classifyNotification(message);
		if (classified.kind === "unknown") {
			// 未知事件只记日志，不报错、不 reject 任何 pending。
			logger.debug(`[rpc] 未知通知方法 ${classified.method}，已忽略。`);
		} else {
			logger.trace(`[rpc] ← 事件 ${classified.event.method} seq=${classified.event.seq}`);
		}
		for (const handler of this.notificationHandlers) {
			try {
				handler(message);
			} catch (error) {
				logger.error(`[rpc] 通知订阅者抛错：${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (classified.kind === "event") {
			for (const handler of this.eventHandlers) {
				try {
					handler(classified.event);
				} catch (error) {
					logger.error(`[rpc] 事件订阅者抛错：${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	private rejectPending(call: PendingCall, error: unknown): void {
		if (call.timer) {
			clearTimeout(call.timer);
		}
		call.cleanupAbort?.();
		call.reject(error);
	}

	private rejectAll(error: TuackRpcError): void {
		const calls = [...this.pending.values()];
		this.pending.clear();
		for (const call of calls) {
			this.rejectPending(call, error);
		}
	}

	private closedError(method: string): TuackRpcError {
		const suffix = this.stateValue === "dead" ? "进程已退出" : "客户端已关闭";
		return TuackRpcError.local(LocalErrorCode.TransportClosed, `${suffix}，无法调用 ${method}。`, {
			method,
			state: this.stateValue,
			recentError: this.lastError?.code,
		});
	}
}

function abortError(method: string, id: RequestId): TuackRpcError {
	return TuackRpcError.local(LocalErrorCode.Aborted, `请求 ${method}（id=${id}）已被取消。`, { method, id });
}
