/**
 * RPC 错误类型。两类错误码：服务端码来自 protocol.ts 的 ErrorCode，原样放在 TuackRpcError.code 上；
 * 本地码（LocalErrorCode）是客户端自己产生的失败，放在服务端不用的 -32090 段，避免撞号，isLocal 可区分。
 *
 * -32000 InternalError 只是服务端的通用失败码，-32003 CompileFailed 与 -32004 RunFailed 才是评测语义错误。
 * run/judge 的单点失败不是 RPC 错误，它是 JudgeResult.status。
 */

import { ErrorCode, type RpcFailure } from "./protocol";

export { ErrorCode };
export type { RpcFailure };

/** 服务端错误码字面量类型。 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 客户端本地错误码。与协议 §5 不冲突（服务端只用 ≥ -32008 的号段）。 */
export const LocalErrorCode = {
	/** 请求在超时时间内没有响应。 */
	Timeout: -32090,
	/** 传输层已关闭（stdout 结束 / 主动 dispose）。 */
	TransportClosed: -32091,
	/** 子进程已退出。`data` 里带退出码、stderr 尾巴与秒退诊断。 */
	ProcessExited: -32092,
	/** 进程启动失败（ENOENT / EACCES / 二进制不是可执行文件）。 */
	SpawnFailed: -32093,
	/** 收到不符合 JSON-RPC 2.0 的信封（非对象、缺 result/error、批量数组…）。 */
	ProtocolViolation: -32094,
	/** `initialize` 声明的 capabilities 里不含该方法所需能力。 */
	CapabilityUnavailable: -32095,
	/** 生命周期违规：`initialize` 之前调用了其它方法，或 `shutdown` 之后又发请求。 */
	LifecycleViolation: -32096,
	/** 在评测面（P2）上调用被禁止的方法（`config/set` / `config/migrate`）。 */
	RoleForbidden: -32097,
	/** 调用方通过 AbortSignal 主动取消。 */
	Aborted: -32098,
} as const;

export type LocalErrorCodeValue = (typeof LocalErrorCode)[keyof typeof LocalErrorCode];

/** 错误码对应的短名。 */
export const ERROR_CODE_NAMES: Readonly<Record<number, string>> = {
	[ErrorCode.ParseError]: "ParseError",
	[ErrorCode.InvalidRequest]: "InvalidRequest",
	[ErrorCode.MethodNotFound]: "MethodNotFound",
	[ErrorCode.InvalidParams]: "InvalidParams",
	[ErrorCode.InternalError]: "InternalError",
	[ErrorCode.SessionNotFound]: "SessionNotFound",
	[ErrorCode.InvalidWorkspace]: "InvalidWorkspace",
	[ErrorCode.CompileFailed]: "CompileFailed",
	[ErrorCode.RunFailed]: "RunFailed",
	[ErrorCode.InvalidConfigField]: "InvalidConfigField",
	[ErrorCode.RunNotFound]: "RunNotFound",
	[ErrorCode.RevisionConflict]: "RevisionConflict",
	[LocalErrorCode.Timeout]: "LocalTimeout",
	[LocalErrorCode.TransportClosed]: "LocalTransportClosed",
	[LocalErrorCode.ProcessExited]: "LocalProcessExited",
	[LocalErrorCode.SpawnFailed]: "LocalSpawnFailed",
	[LocalErrorCode.ProtocolViolation]: "LocalProtocolViolation",
	[LocalErrorCode.CapabilityUnavailable]: "LocalCapabilityUnavailable",
	[LocalErrorCode.LifecycleViolation]: "LocalLifecycleViolation",
	[LocalErrorCode.RoleForbidden]: "LocalRoleForbidden",
	[LocalErrorCode.Aborted]: "LocalAborted",
};

/** 错误码对应的面向用户的中文说明（不含具体上下文）。 */
const ERROR_CODE_HINTS: Readonly<Record<number, string>> = {
	[ErrorCode.ParseError]: "服务端无法解析请求（客户端 bug 或协议版本不匹配）。",
	[ErrorCode.InvalidRequest]: "请求信封不合法。",
	[ErrorCode.MethodNotFound]: "服务端不认识该方法：可能是 tuack-ng 版本过旧。",
	[ErrorCode.InvalidParams]: "参数不合法（字段名/类型/scope 转义错误）。",
	[ErrorCode.InternalError]: "tuack-ng 内部错误。",
	[ErrorCode.SessionNotFound]: "会话不存在：进程已被回收，需要重新 workspace/open。",
	[ErrorCode.InvalidWorkspace]: "当前目录不是有效的 Tuack 竞赛工程（缺 conf.json 或 folder 字段）。",
	[ErrorCode.CompileFailed]: "选手程序编译失败。",
	[ErrorCode.RunFailed]: "评测流程失败。",
	[ErrorCode.InvalidConfigField]: "配置路径不存在（注意 kebab-case 与带空格的键，如 \"time limit\"）。",
	[ErrorCode.RunNotFound]: "run 不存在：run 只活在评测进程内存里，进程重启后必然丢失。",
	[ErrorCode.RevisionConflict]: "revision 冲突（乐观并发失败）。",
	[LocalErrorCode.Timeout]: "请求超时。若正在 run/judge，注意同步 handler 会让该进程暂时发不出任何请求。",
	[LocalErrorCode.TransportClosed]: "RPC 传输已关闭。",
	[LocalErrorCode.ProcessExited]: "tuack-ng-rpc 进程已退出。",
	[LocalErrorCode.SpawnFailed]: "无法启动 tuack-ng-rpc。",
	[LocalErrorCode.ProtocolViolation]: "服务端发来的消息不是合法 JSON-RPC 信封。",
	[LocalErrorCode.CapabilityUnavailable]: "服务端未声明该能力，调用被客户端拦截。",
	[LocalErrorCode.LifecycleViolation]: "JSON-RPC 生命周期违规（必须先 initialize，shutdown 后只能 exit）。",
	[LocalErrorCode.RoleForbidden]: "该操作在评测面（P2）上被禁止：revision 是进程级的，跨进程乐观并发不成立。",
	[LocalErrorCode.Aborted]: "调用已被取消。",
};

export function errorCodeName(code: number): string {
	return ERROR_CODE_NAMES[code] ?? `Unknown(${code})`;
}

/** 把错误码翻译成一句可读说明；未知码原样带出。 */
export function describeErrorCode(code: number): string {
	return ERROR_CODE_HINTS[code] ?? `未知错误码 ${code}。`;
}

/** 本地失败的 `data` 形状：超时。 */
export interface TimeoutErrorData {
	method: string;
	id: number | string;
	timeoutMs: number;
}

/** 本地失败的 `data` 形状：进程退出 / 秒退。 */
export interface ProcessExitErrorData {
	exitCode: number | null;
	signal: string | null;
	stdoutBytes: number;
	stderr: string;
	/** 进程在读到 stdin 之前就退出了（典型：assets/langs.json 缺失）。 */
	fastExit: boolean;
	/** 秒退时的可操作诊断。 */
	diagnosis?: QuickExitDiagnosis;
}

/** 秒退诊断，由 `core/process.ts` 产出。 */
export interface QuickExitDiagnosis {
	kind: "assets-missing" | "binary-missing" | "spawn-failed" | "signaled" | "unknown";
	summary: string;
	advice: string[];
}

/**
 * 所有 RPC 失败的统一异常类型。code 保留服务端或本地的数字错误码，data 保留 JSON-RPC error.data。
 */
export class TuackRpcError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "TuackRpcError";
		this.code = code;
		this.data = data;
	}

	/** 由服务端 `error` 对象构造。 */
	static fromFailure(failure: RpcFailure): TuackRpcError {
		const { code, message, data } = failure.error;
		const detail = describeErrorCode(code);
		const text = message && message.length > 0 ? message : detail;
		return new TuackRpcError(code, `[${errorCodeName(code)} ${code}] ${text}`, data);
	}

	/** 本地错误码构造。 */
	static local(code: number, message: string, data?: unknown): TuackRpcError {
		return new TuackRpcError(code, `[${errorCodeName(code)} ${code}] ${message}`, data);
	}

	/** 由任意异常包装成本地错误（保留原来的 message 作为 data.causeMessage）。 */
	static fromUnknown(code: number, prefix: string, cause: unknown): TuackRpcError {
		const message = cause instanceof Error ? cause.message : String(cause);
		return new TuackRpcError(code, `${prefix}：${message}`, { causeMessage: message }, { cause });
	}

	get codeName(): string {
		return errorCodeName(this.code);
	}

	/** 是否为客户端本地错误（非服务端返回）。 */
	get isLocal(): boolean {
		return this.code <= -32090;
	}

	get isTimeout(): boolean {
		return this.code === LocalErrorCode.Timeout;
	}

	get isMethodNotFound(): boolean {
		return this.code === ErrorCode.MethodNotFound;
	}

	get isProcessGone(): boolean {
		return this.code === LocalErrorCode.ProcessExited || this.code === LocalErrorCode.TransportClosed;
	}

/** 面向用户的可读说明（错误码的通用解释）。 */
	get hint(): string {
		return describeErrorCode(this.code);
	}

	/** `data` 的类型化读取（不校验形状，调用方自行判断）。 */
	dataAs<T>(): T | undefined {
		return this.data as T | undefined;
	}
}

/** 判定任意值是否为 `TuackRpcError`；给 `code` 时按数字或数字数组精确匹配。 */
export function isRpcError(value: unknown, code?: number | readonly number[]): value is TuackRpcError {
	if (!(value instanceof TuackRpcError)) {
		return false;
	}
	if (code === undefined) {
		return true;
	}
	return typeof code === "number" ? value.code === code : code.includes(value.code);
}

/** 便捷构造：方法未找到（服务端 `-32601`）。 */
export function methodNotFoundError(method: string): TuackRpcError {
	return new TuackRpcError(ErrorCode.MethodNotFound, `[MethodNotFound -32601] 服务端不认识方法 ${method}。`);
}

/** 把未知异常归一成 `TuackRpcError`（已经是的原样返回）。 */
export function asRpcError(value: unknown, fallbackCode: number = ErrorCode.InternalError): TuackRpcError {
	if (isRpcError(value)) {
		return value;
	}
	return TuackRpcError.fromUnknown(fallbackCode, "RPC 调用失败", value);
}
