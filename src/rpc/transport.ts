/**
 * NDJSON 分帧（tuack-ng-rpc 的传输层）。
 *
 * 关键事实：**一个 `data` 事件不等于一行**。
 * - stdout 的一行可能被拆成任意多个 chunk（管道缓冲、大 JSON 参数）；
 * - 一个 chunk 里可能有多行；
 * - 多字节 UTF-8 字符可能被切成两半。
 *
 * 做法：只在**字节层**扫描 `\n`（0x0A），把「含换行符的完整行」的字节切片单独
 * `toString("utf8")`。这天然不会切开多字节字符——UTF-8 的续字节都 >= 0x80，
 * 不可能等于 0x0A，所以「完整行」必定是完整字符序列。
 *
 * 刻意**不用** `setEncoding("utf8")` + `readline`：那样会把分帧交给 Node 的
 * StringDecoder/readline，出问题时看不到原始字节，也无法对超长行设上限
 * （对端一旦发出没有换行的垃圾数据，内存会无界增长）。
 *
 * 恢复策略：解析失败（非法 JSON、非对象信封）只回调 `onParseError` 并继续处理下一行，
 * 绝不打断流；超长行则丢弃到下一个换行符为止再重新同步。
 */

import { LocalErrorCode, TuackRpcError } from "./errors";
import { logger } from "../core/log";

/** 默认单行上限 8 MiB：`config/get` 返回整份 conf.json，正常远小于此。 */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface SplitLinesResult {
	/** 完整行（已去掉 `\n`，并去掉行尾 `\r` 与行首 BOM）。空行会是 `""`。 */
	lines: string[];
	/** 尚未遇到换行的剩余字节（下一次 `push` 要带上）。 */
	rest: Buffer;
}

/**
 * 纯函数分帧：把 `pending` 与 `chunk` 拼起来，切出所有完整行。
 *
 * `rest` 与 `pending` 共享内存（`subarray`），调用方不要原地改写。
 */
export function splitLines(pending: Buffer, chunk: Buffer | string): SplitLinesResult {
	const incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
	const buffer = pending.length === 0 ? incoming : Buffer.concat([pending, incoming], pending.length + incoming.length);

	const lines: string[] = [];
	let start = 0;
	for (;;) {
		const newline = buffer.indexOf(0x0a, start);
		if (newline === -1) {
			break;
		}
		lines.push(decodeLine(buffer, start, newline));
		start = newline + 1;
	}
	return { lines, rest: start === 0 ? buffer : buffer.subarray(start) };
}

/** 解出一行文本：去掉 CRLF 的 `\r`，并剥掉可能出现在流首的 UTF-8 BOM。 */
function decodeLine(buffer: Buffer, start: number, end: number): string {
	let stop = end;
	if (stop > start && buffer[stop - 1] === 0x0d) {
		stop -= 1;
	}
	let text = buffer.toString("utf8", start, stop);
	if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	return text;
}

export type NdjsonParseErrorKind = "json" | "shape" | "overflow";

/** 分帧层面的解析错误（不是 RPC 错误；只用于日志与诊断）。 */
export class NdjsonParseError extends Error {
	readonly kind: NdjsonParseErrorKind;
	/** 出错的那一行（超长行时为空字符串，避免把 8 MiB 垃圾塞进日志）。 */
	readonly line: string;
	readonly byteLength: number;

	constructor(kind: NdjsonParseErrorKind, message: string, line: string, byteLength: number, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "NdjsonParseError";
		this.kind = kind;
		this.line = line;
		this.byteLength = byteLength;
	}
}

export type TransportEndReason = "input-end" | "input-error" | "closed";

export interface NdjsonTransportOptions {
	/** 子进程 stdout（或任意可读流）。 */
	input: NodeJS.ReadableStream;
	/** 子进程 stdin（或任意可写流）。 */
	output: NodeJS.WritableStream;
	/** 每收到一条完整且合法的 JSON 对象就回调一次。 */
	onMessage: (message: Record<string, unknown>) => void;
	/** 解析/超长行失败（可恢复）。 */
	onParseError?: (error: NdjsonParseError) => void;
	/** stdout 结束或出错（不可恢复）。 */
	onEnd?: (reason: TransportEndReason, error?: Error) => void;
	/** 是否把消息里缺 `jsonrpc` 字段的情况记为 warn（默认 true，仅日志）。 */
	strictEnvelope?: boolean;
	maxLineBytes?: number;
}

/**
 * NDJSON 传输：`writeValue()` 发一条消息，`onMessage()` 收一条消息。
 *
 * 本类不做请求关联、不解析语义——那是 `RpcClient` 的事。
 */
export class NdjsonTransport {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;

	private readonly options: NdjsonTransportOptions;
	private readonly maxLineBytes: number;
	private readonly strictEnvelope: boolean;

	private pending: Buffer = Buffer.alloc(0);
	/** 正在丢弃一条超长行，直到下一个换行符为止。 */
	private dropping = false;
	private closed = false;

	/** 从 stdout 收到的原始字节数——秒退识别要用（`stdout 零字节`）。 */
	private bytesIn = 0;
	/** 成功解析出的消息条数。 */
	private messageCount = 0;
	private parseErrorCount = 0;

	private readonly handleData = (chunk: Buffer | string): void => {
		if (this.closed) {
			return;
		}
		this.bytesIn += typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;

		let incoming = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		if (this.dropping) {
			const newline = incoming.indexOf(0x0a);
			if (newline === -1) {
				return;
			}
			this.dropping = false;
			incoming = incoming.subarray(newline + 1);
			if (incoming.length === 0) {
				return;
			}
		}

		const { lines, rest } = splitLines(this.pending, incoming);
		this.pending = rest;
		for (const line of lines) {
			this.dispatchLine(line);
		}

		if (this.pending.length > this.maxLineBytes) {
			const bytes = this.pending.length;
			this.pending = Buffer.alloc(0);
			this.dropping = true;
			this.raise(
				new NdjsonParseError(
					"overflow",
					`单行超过 ${this.maxLineBytes} 字节上限（已丢弃 ${bytes} 字节，等待下一个换行符重新同步）`,
					"",
					bytes,
				),
			);
		}
	};

	private readonly handleEnd = (): void => {
		if (this.closed) {
			return;
		}
		// 收尾：最后一行如果没有换行符也要尝试解析一次（对端正常来说都会带 \n）。
		if (this.pending.length > 0) {
			const remainder = decodeLine(this.pending, 0, this.pending.length);
			this.pending = Buffer.alloc(0);
			if (remainder.trim().length > 0) {
				this.dispatchLine(remainder);
			}
		}
		this.emitEnd("input-end");
	};

	private readonly handleError = (error: Error): void => {
		if (this.closed) {
			return;
		}
		this.emitEnd("input-error", error);
	};

	constructor(options: NdjsonTransportOptions) {
		this.options = options;
		this.input = options.input;
		this.output = options.output;
		this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
		this.strictEnvelope = options.strictEnvelope ?? true;

		this.input.on("data", this.handleData);
		this.input.on("end", this.handleEnd);
		this.input.on("error", this.handleError);
		this.input.on("close", this.handleEnd);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get bytesReceived(): number {
		return this.bytesIn;
	}

	get messagesReceived(): number {
		return this.messageCount;
	}

	get parseErrors(): number {
		return this.parseErrorCount;
	}

	get bufferedBytes(): number {
		return this.pending.length;
	}

	/** 写一条消息（自动补 `\n`）。返回流是否还需要背压等待。 */
	writeValue(value: unknown): boolean {
		let text: string;
		try {
			text = JSON.stringify(value);
		} catch (error) {
			throw TuackRpcError.fromUnknown(LocalErrorCode.ProtocolViolation, "无法序列化要发送的消息", error);
		}
		if (typeof text !== "string") {
			throw new TuackRpcError(LocalErrorCode.ProtocolViolation, "要发送的消息无法序列化为 JSON 文本。");
		}
		return this.writeLine(text);
	}

	/** 写一整行（调用方保证不含换行；含换行会被原样写出，不会自动纠正）。 */
	writeLine(line: string): boolean {
		if (this.closed) {
			throw TuackRpcError.local(LocalErrorCode.TransportClosed, "传输已关闭，无法写入。");
		}
		return this.output.write(`${line}\n`);
	}

	/** 摘掉监听器并标记关闭。**不**结束 output（stdin 的关闭由进程封装决定）。 */
	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.pending = Buffer.alloc(0);
		this.input.off("data", this.handleData);
		this.input.off("end", this.handleEnd);
		this.input.off("error", this.handleError);
		this.input.off("close", this.handleEnd);
	}

	private dispatchLine(line: string): void {
		if (line.trim().length === 0) {
			logger.trace("[rpc] 收到空行，忽略。");
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error) {
			// 解析失败必须可恢复：对端可能把人类可读的日志/panic 写到了 stdout。
			this.raise(
				new NdjsonParseError("json", "无法解析为 JSON", truncate(line), Buffer.byteLength(line, "utf8"), { cause: error }),
			);
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			this.raise(
				new NdjsonParseError(
					"shape",
					Array.isArray(parsed) ? "收到批量数组信封（协议只允许单个对象）" : "JSON 顶层不是对象",
					truncate(line),
					Buffer.byteLength(line, "utf8"),
				),
			);
			return;
		}
		const message = parsed as Record<string, unknown>;
		if (this.strictEnvelope && message["jsonrpc"] !== "2.0") {
			logger.warn(`[rpc] 消息缺少 jsonrpc:"2.0" 字段，仍按原样交给上层：${truncate(line, 200)}`);
		}
		this.messageCount += 1;
		this.options.onMessage(message);
	}

	private raise(error: NdjsonParseError): void {
		this.parseErrorCount += 1;
		logger.warn(`[rpc] NDJSON 分帧错误（${error.kind}）：${error.message}`);
		this.options.onParseError?.(error);
	}

	private emitEnd(reason: TransportEndReason, error?: Error): void {
		this.closed = true;
		this.input.off("data", this.handleData);
		this.input.off("end", this.handleEnd);
		this.input.off("error", this.handleError);
		this.input.off("close", this.handleEnd);
		if (error) {
			logger.warn(`[rpc] stdout 出错：${error.message}`);
		}
		this.options.onEnd?.(reason, error);
	}
}

/** 日志里截断长文本（分帧错误可能带着巨大的单行）。 */
export function truncate(text: string, max = 400): string {
	return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max} 字符)`;
}
