/**
 * tuack-ng-rpc 协议 v0.1 的类型契约，只描述协议形状，不含任何网络/进程逻辑。
 * 依据上游 tuack-ng 的 rpc 分支，crates/tuack-ng-rpc/PROTOCOL.md。
 *
 * 反直觉的几条写在对应类型旁边：事件可能早于触发它的响应、run/finished 没有成功终态、
 * revision 与 id 计数器是进程级的。另外 run/judge、run/score、ren/preview、config/* 是同步 handler，会阻塞该进程的读循环。
 */

export const PROTOCOL_VERSION = "0.1";

// ─────────────────────────────────────────────────────────────────────────────
// 基础类型
// ─────────────────────────────────────────────────────────────────────────────

/** `workspace/open` 创建的会话标识。 */
export type SessionId = string;
/** `run/create` 创建的评测会话标识。 */
export type RunId = string;
/** `ren/run` 创建的渲染任务标识。 */
export type TaskId = string;

/**
 * 配置作用域：`"contest"` | `"<day>"` | `"<day>/<problem>"`。
 * day/problem 的 key 内含 `/` 或 `~` 时必须按 JSON Pointer 规则转义（`~0` / `~1`）。
 */
export type Scope = string;
/** RFC 6901 JSON Pointer；`""` 指向整个 FileView 文档。 */
export type JsonPointer = string;
/** `file://` 形式的绝对资源标识。 */
export type Uri = string;
/** 相对竞赛工程根的路径，如 `"day1/conf.json"`、`"day1/p1"`。 */
export type ContestRelativePath = string;

export type ProblemType = "program" | "output" | "interactive";

/** 单个数据点的裁决结果。PC 会携带 score。 */
export type TestStatus = "AC" | "WA" | "RE" | "TLE" | "MLE" | "UKE" | "FE" | "PC";

/** run 的生命周期状态（不表示当前是否有 RPC 操作在执行）。 */
export type RunState = "preparing" | "ready" | "cancelled" | "error" | "closed";
/** 渲染任务状态。 */
export type RenState = "running" | "finished" | "cancelled" | "error";

/** `run/output` 的通道。当前实现只发出 `compiler` 与 `judge`。 */
export type Channel = "stdout" | "stderr" | "compiler" | "judge" | "renderer" | "system";

/** `ren/output` 的通道。 */
export type RenChannel = "renderer" | "system";

/** `initialize` 返回的能力列表。调用未声明的方法前应先校验。 */
export type Capability = "workspace" | "config" | "problem" | "run" | "ren";

/** JSON-RPC 错误码（协议 §5）。 */
export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32000,
	SessionNotFound: -32001,
	InvalidWorkspace: -32002,
	CompileFailed: -32003,
	RunFailed: -32004,
	InvalidConfigField: -32005,
	RunNotFound: -32006,
	RevisionConflict: -32007,
} as const;
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─────────────────────────────────────────────────────────────────────────────
// 配置（FileView，与 conf.json 文件内容一致）
// ─────────────────────────────────────────────────────────────────────────────

/** 任意 JSON 值（`config/set` 的 `value`）。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * conf.json 的 FileView 形态。字段名与文件完全一致，含 kebab-case 与带空格的键
 * （`"time limit"`、`"memory limit"`、`"start time"`、`"end time"`、`"short title"`），拼错会得到 `-32005`。
 */
export type FileView = { [key: string]: JsonValue };

/** `config/schema` 返回的三份 JSON Schema（draft-07）。 */
export interface ConfigSchema {
	contest: JsonValue;
	day: JsonValue;
	problem: JsonValue;
}

export interface ConfigView {
	/** session-global revision（初始 0，表示"未经本 session 修改"）。 */
	revision: number;
	config: FileView;
	/** 相对工程根的路径。 */
	path: ContestRelativePath;
	uri: Uri;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工作区 / 题目
// ─────────────────────────────────────────────────────────────────────────────

export interface ContestInfo {
	name: string;
	days: string[];
	/** 工程根（可能不同于 `workspace/open` 传入的目录）。 */
	uri: Uri;
}

export interface WorkspaceOpenResult {
	sessionId: SessionId;
	workspace: { uri: Uri };
	/** 无有效工程时为 `null`，此后 config/problem/run 相关方法返回 `-32002`。 */
	contest: ContestInfo | null;
}

export interface SessionInfo {
	sessionId: SessionId;
	uri: Uri;
}

/** `problem/list` 的元素；`path` 已按 scope 转义规则编码，可直接回传。 */
export interface ProblemDescriptor {
	/** 题目的 key（配置里的目录名）。 */
	name: string;
	title: string;
	problemType: ProblemType;
	path: ContestRelativePath;
}

export interface DataPoint {
	/**
	 * 展开后的数据点 id（bundle 已展开）。服务端返回数字，但 `run/judge` 的 `testId` 只收字符串，
	 * 调用点要显式 `String(point.id)`，否则得到 `-32602`。见 `.cache/research/rpc-smoke-report.md` 的 D2。
	 */
	id: number;
	score: number;
	subtask: number;
}

export interface SamplePoint {
	/** 同 `DataPoint.id`：线上是 number，`run/judge` 需要 string。 */
	id: number;
	input: string;
	output: string;
}

/** `problem/get` 的领域对象（非 tuack-ng 内部类型的投影）。 */
export interface ProblemDetail {
	name: string;
	title: string;
	problemType: ProblemType;
	timeLimitMs: number;
	memoryLimitBytes: number;
	fileIo: boolean | null;
	data: DataPoint[];
	samples: SamplePoint[];
	checker: JsonValue;
	validator: JsonValue;
	path: ContestRelativePath;
}

// ─────────────────────────────────────────────────────────────────────────────
// 评测（run）
// ─────────────────────────────────────────────────────────────────────────────

export type RunTarget = "data" | "sample";

export interface RunCreateParams {
	sessionId: SessionId;
	/** `"<day>/<problem>"`，已转义。 */
	problem: string;
	target: RunTarget;
	/** `tests` 的 key；缺省 `"std"`，`"std"` 不存在时回退 `tests` 的第一条。 */
	tester?: string;
}

/** `run/judge` 的结果，也是每个数据点唯一的权威结果。 */
export interface JudgeResult {
	testId: string;
	status: TestStatus;
	/** `TLE` / `MLE` 时为 `null`。 */
	timeMs: number | null;
	memoryBytes: number | null;
	/**
	 * checker 报告（如 `"AC"` / `"Wrong answer on test 7"`）或错误诊断。
	 * 线上 RE / TLE 时给的是 null（报告 D3），展示前要做空值兜底。
	 */
	message: string | null;
	/** 归一化得分：`AC` = 1.0，`PC` ∈ (0,1)，其余 0.0。 */
	score: number;
	/** 该点满分。 */
	fullScore: number;
}

export interface ScoreGroup {
	id: number;
	earned: number;
	full: number;
}

export interface ScoreReport {
	groups: ScoreGroup[];
	total: number;
	fullScore: number;
}

export interface RunScoreResult {
	judged: number;
	total: number;
	report: ScoreReport;
}

/** `run/get` 的权威快照（同进程内有效；进程死亡后不可恢复）。 */
export interface RunGetResult {
	state: RunState;
	problem: string;
	target: RunTarget;
	tester: string;
	judged: JudgeResult[];
	report: ScoreReport | null;
	error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染（ren）
// ─────────────────────────────────────────────────────────────────────────────

/** 渲染前后行映射的一项。`source` 为原始 statement.md 的行号，`rendered` 为展开后的行号。 */
export interface LineMapEntry {
	/** 1 起。 */
	source: number;
	/** 1 起。 */
	rendered: number;
}

/**
 * `ren/preview` 的结果：MiniJinja 展开后的 Markdown（未做 AST 解析/渲染），`scope` 必须精确到单个题目。
 * 同一 `source` 渲染多次（`{% for %}` 循环体）时只记第一次出现的 `rendered`，循环体无法双向映射，
 * 滚动同步应以渲染侧的 `data-source-line` 为主。
 */
export interface RenPreviewResult {
	markdown: string;
	warnings: string[];
	lineMap: LineMapEntry[];
}

export interface RenFile {
	/** 相对 `tmpDir` 的路径（客户端需自行 join）。 */
	path: string;
}

/**
 * `ren/get` 的权威快照。`tmpDir` 由上游 `TempDir::keep()` 创建，永不自动清理，客户端用完要自己删。
 */
export interface RenGetResult {
	state: RenState;
	template: string;
	progress: { done: number; total: number };
	tmpDir: string;
	files: RenFile[];
	warnings: string[];
	error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON-RPC 信封
// ─────────────────────────────────────────────────────────────────────────────

export type RequestId = number | string;

export interface RpcRequest<P = unknown> {
	jsonrpc: "2.0";
	id: RequestId;
	method: string;
	params?: P;
}

export interface RpcNotification<P = unknown> {
	jsonrpc: "2.0";
	method: string;
	params?: P;
}

export interface RpcSuccess<R = unknown> {
	jsonrpc: "2.0";
	id: RequestId;
	result: R;
}

export interface RpcFailure {
	jsonrpc: "2.0";
	id: RequestId | null;
	error: { code: number; message: string; data?: unknown };
}

export type RpcResponse<R = unknown> = RpcSuccess<R> | RpcFailure;

export function isResponse(msg: unknown): msg is RpcResponse {
	return typeof msg === "object" && msg !== null && "id" in msg && ("result" in msg || "error" in msg);
}

export function isNotification(msg: unknown): msg is RpcNotification {
	return (
		typeof msg === "object" &&
		msg !== null &&
		"method" in msg &&
		!("id" in msg) &&
		!("result" in msg) &&
		!("error" in msg)
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// 方法映射（请求与结果）
// ─────────────────────────────────────────────────────────────────────────────

export interface InitializeResult {
	protocolVersion: string;
	serverInfo: { name: string; version: string };
	capabilities: Capability[];
}

/**
 * 请求方法的 params/result 映射表，`undefined` 表示无 params。`RpcClient.call()` 的类型来源。
 */
export interface MethodMap {
	initialize: { params: { clientInfo: { name: string; version: string } }; result: InitializeResult };
	shutdown: { params: undefined; result: null };

	"workspace/open": { params: { uri: Uri }; result: WorkspaceOpenResult };
	"workspace/close": { params: { sessionId: SessionId }; result: null };
	"workspace/list": { params: undefined; result: { sessions: SessionInfo[] } };

	"config/schema": { params: undefined; result: ConfigSchema };
	"config/get": { params: { sessionId: SessionId; scope?: Scope }; result: ConfigView };
	"config/set": {
		params: {
			sessionId: SessionId;
			scope?: Scope;
			field?: JsonPointer;
			value: JsonValue;
			revision?: number;
		};
		result: { revision: number; config: FileView };
	};
	"config/reload": { params: { sessionId: SessionId; scope?: Scope }; result: ConfigView };
	"config/migrate": {
		params: { sessionId: SessionId };
		result: { migrated: boolean; notices: string[] };
	};

	"problem/list": {
		params: { sessionId: SessionId; scope?: Scope };
		result: { problems: ProblemDescriptor[] };
	};
	"problem/get": {
		params: { sessionId: SessionId; problem: string };
		result: { problem: ProblemDetail };
	};

	"run/create": { params: RunCreateParams; result: { runId: RunId } };
	"run/judge": { params: { sessionId: SessionId; runId: RunId; testId: string }; result: JudgeResult };
	"run/score": { params: { sessionId: SessionId; runId: RunId }; result: RunScoreResult };
	"run/cancel": { params: { sessionId: SessionId; runId: RunId }; result: null };
	"run/get": { params: { sessionId: SessionId; runId: RunId }; result: RunGetResult };

	"ren/preview": {
		params: { sessionId: SessionId; scope: Scope; template?: string };
		result: RenPreviewResult;
	};
	"ren/run": { params: { sessionId: SessionId; template: string; scope?: Scope }; result: { taskId: TaskId } };
	"ren/cancel": { params: { sessionId: SessionId; taskId: TaskId }; result: null };
	"ren/get": { params: { sessionId: SessionId; taskId: TaskId }; result: RenGetResult };
}

export type MethodName = keyof MethodMap;
export type MethodParams<M extends MethodName> = MethodMap[M]["params"];
export type MethodResult<M extends MethodName> = MethodMap[M]["result"];

/** 协议里出现的全部方法名。 */
export const KNOWN_METHODS: readonly MethodName[] = [
	"initialize",
	"shutdown",
	"workspace/open",
	"workspace/close",
	"workspace/list",
	"config/schema",
	"config/get",
	"config/set",
	"config/reload",
	"config/migrate",
	"problem/list",
	"problem/get",
	"run/create",
	"run/judge",
	"run/score",
	"run/cancel",
	"run/get",
	"ren/preview",
	"ren/run",
	"ren/cancel",
	"ren/get",
];

// ─────────────────────────────────────────────────────────────────────────────
// 服务端到客户端的事件
// ─────────────────────────────────────────────────────────────────────────────

/** 所有事件共有的字段。`seq` 为进程级单调递增序号，用于检测事件序列缺口。 */
export interface EventBase {
	seq: number;
	sessionId: SessionId;
}

export interface RunStartedEvent extends EventBase {
	method: "run/started";
	runId: RunId;
	problem: string;
	target: RunTarget;
	tester: string;
}

/** `testId` 为 `null` 时表示编译器/系统输出。 */
export interface RunOutputEvent extends EventBase {
	method: "run/output";
	runId: RunId;
	testId: string | null;
	channel: Channel;
	text: string;
}

export interface RunReadyEvent extends EventBase {
	method: "run/ready";
	runId: RunId;
}

/** `state` 只会是 `cancelled` / `error` / `closed`，没有成功终态。 */
export interface RunFinishedEvent extends EventBase {
	method: "run/finished";
	runId: RunId;
	state: Extract<RunState, "cancelled" | "error" | "closed">;
	error?: string;
}

export interface RenStartedEvent extends EventBase {
	method: "ren/started";
	taskId: TaskId;
	template: string;
	scope: Scope;
}

export interface RenOutputEvent extends EventBase {
	method: "ren/output";
	taskId: TaskId;
	channel: RenChannel;
	text: string;
}

export interface RenProgressEvent extends EventBase {
	method: "ren/progress";
	taskId: TaskId;
	done: number;
	total: number;
	/** 当前完成的层级名（如 day key）。 */
	item: string;
}

export interface RenFinishedEvent extends EventBase {
	method: "ren/finished";
	taskId: TaskId;
	status: Extract<RenState, "finished" | "error" | "cancelled">;
	tmpDir: string | null;
	files: RenFile[];
	warnings: string[];
	error: string | null;
}

export type RpcEvent =
	| RunStartedEvent
	| RunOutputEvent
	| RunReadyEvent
	| RunFinishedEvent
	| RenStartedEvent
	| RenOutputEvent
	| RenProgressEvent
	| RenFinishedEvent;

export type RpcEventMethod = RpcEvent["method"];

/**
 * 已知事件方法名。收到不在列表里的通知只记日志、不报错，
 * 这样 tuack-ng 新增事件（例如增量预览推送）不需要客户端同步升级。
 */
export const KNOWN_EVENT_METHODS: readonly RpcEventMethod[] = [
	"run/started",
	"run/output",
	"run/ready",
	"run/finished",
	"ren/started",
	"ren/output",
	"ren/progress",
	"ren/finished",
];

export function isKnownEvent(method: string): method is RpcEventMethod {
	return (KNOWN_EVENT_METHODS as readonly string[]).includes(method);
}

// ─────────────────────────────────────────────────────────────────────────────
// scope 转义（协议 §4）
// ─────────────────────────────────────────────────────────────────────────────

/** 转义单个 scope 段：先 `~` 换成 `~0`，再 `/` 换成 `~1`。 */
export function escapeScopeSegment(segment: string): string {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** 还原单个 scope 段：先 `~1` 换成 `/`，再 `~0` 换成 `~`。 */
export function unescapeScopeSegment(segment: string): string {
	return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** 把 `[day, problem]` 拼成协议 scope 字符串。 */
export function makeScope(day?: string, problem?: string): Scope {
	if (!day) {
		return "contest";
	}
	const parts = [escapeScopeSegment(day)];
	if (problem) {
		parts.push(escapeScopeSegment(problem));
	}
	return parts.join("/");
}

/** 解析 scope 字符串为 `{ day?, problem? }`。 */
export function parseScope(scope: Scope): { day?: string; problem?: string } {
	if (scope === "contest" || scope === "") {
		return {};
	}
	const parts = scope.split("/").map(unescapeScopeSegment);
	return { day: parts[0], problem: parts[1] };
}

/** 拼出 `"<day>/<problem>"` 形式的 problem 标识。 */
export function makeProblemId(day: string, problem: string): string {
	return `${escapeScopeSegment(day)}/${escapeScopeSegment(problem)}`;
}
