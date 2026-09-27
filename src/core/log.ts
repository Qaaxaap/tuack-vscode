/**
 * 扩展的日志出口。
 *
 * 用 `LogOutputChannel`（VS Code 1.74+）而不是普通 OutputChannel：
 * 它带分级、跟随 `developer.logLevel`、支持 `onDidChangeLogLevel`，
 * 也在「输出」面板里可被用户按级别过滤。
 *
 * 注意：`LogOutputChannel.logLevel` 是**只读**的（由用户通过 VS Code 自己的
 * 「设置日志级别」控制），扩展无法直接改写。因此 `tuack.logLevel` 设置项由本模块
 * 在应用层做一次过滤，两者互不冲突：用户把 channel 级别调低不会让日志变多，
 * 把 `tuack.logLevel` 调高也不会绕过 VS Code 自身的最小级别。
 */

import * as vscode from "vscode";

export const OUTPUT_CHANNEL_NAME = "Tuack";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevelName, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

let channel: vscode.LogOutputChannel | undefined;
let threshold = ORDER.info;

export interface Logger {
	trace(message: string, ...args: unknown[]): void;
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

function refreshThreshold(): void {
	const configured = vscode.workspace
		.getConfiguration("tuack")
		.get<LogLevelName>("logLevel", "info");
	threshold = ORDER[configured] ?? ORDER.info;
}

function emit(level: LogLevelName, message: string, args: unknown[]): void {
	if (ORDER[level] < threshold) {
		return;
	}
	const target = channel;
	if (!target) {
		// 激活早期或激活失败时静默丢弃，避免日志本身把扩展搞崩。
		return;
	}
	target[level](message, ...args);
}

export const logger: Logger = {
	trace: (message, ...args) => emit("trace", message, args),
	debug: (message, ...args) => emit("debug", message, args),
	info: (message, ...args) => emit("info", message, args),
	warn: (message, ...args) => emit("warn", message, args),
	error: (message, ...args) => emit("error", message, args),
};

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
	const created = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
	channel = created;
	context.subscriptions.push(created);
	refreshThreshold();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("tuack.logLevel")) {
				refreshThreshold();
			}
		}),
	);
	return created;
}

/** 取原始输出通道（用于 `show()` 等 UI 操作）。激活前调用会抛错。 */
export function outputChannel(): vscode.LogOutputChannel {
	if (!channel) {
		throw new Error("日志通道尚未初始化：请先在 activate() 中调用 initLog()");
	}
	return channel;
}
