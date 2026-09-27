/**
 * 扩展入口。
 *
 * 职责分工（各阶段的接入点已在下方标注）：
 * - 阶段 0（Lead）：激活、日志、工作区事件、命令注册骨架。
 * - 阶段 1：`rpc/` 的进程与传输层（RpcPool / RpcClient）在此装配。
 * - 阶段 2：预览控制器与 webview 宿主。
 * - 阶段 3：结构树 provider 与 conf.json 诊断。
 * - 阶段 4：测试控制器与 CLI 通道。
 * - 阶段 5：环境诊断面板、语言支持。
 *
 * 注意：本文件只做「组装」，不承载具体业务逻辑。
 * 用户可见字符串一律走 `vscode.l10n.t()`（见 `l10n/`）。
 */

import * as vscode from "vscode";

import { initLog, logger, outputChannel } from "./core/log";

/** 尚未接入的功能：给出可操作的提示，而不是静默失败。 */
function notImplementedYet(command: string): void {
	const message = vscode.l10n.t("Tuack: command {0} is not wired up yet.", command);
	const showLogs = vscode.l10n.t("Show Logs");
	void vscode.window.showInformationMessage(message, showLogs).then((picked) => {
		if (picked === showLogs) {
			void vscode.commands.executeCommand("tuack.showLogs");
		}
	});
}

export function activate(context: vscode.ExtensionContext): void {
	initLog(context);

	const version = context.extension.packageJSON.version as string;
	logger.info(`Tuack extension activated (version ${version})`);

	const folders = vscode.workspace.workspaceFolders ?? [];
	logger.debug(`workspace folders: ${folders.length}`);
	for (const folder of folders) {
		logger.debug(`  folder: ${folder.uri.toString()}${folder.name ? ` (${folder.name})` : ""}`);
	}

	// ── 基础设施命令 ────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand("tuack.showLogs", () => {
			outputChannel().show();
		}),

		// 阶段 5：由 core/diagnose.ts 提供真实实现（列出二进制、assets、模板、进程与最近错误码）。
		vscode.commands.registerCommand("tuack.diagnose", () => {
			outputChannel().show();
			logger.info("diagnose: not wired up yet (planned stage 5)");
			notImplementedYet("tuack.diagnose");
		}),

		// 阶段 3：由 features/tree 提供真实实现。
		vscode.commands.registerCommand("tuack.refresh", () => {
			notImplementedYet("tuack.refresh");
		}),
	);

	if (folders.length === 0) {
		logger.debug("no workspace folder is open; Tuack features will light up once a contest is opened");
	}

	// ── 配置变更 ────────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("tuack.rpcPath") || e.affectsConfiguration("tuack.assetsPath")) {
				logger.info(
					"binary/assets path changed; it takes effect on the next probe, existing connections keep the old path",
				);
			}
		}),
	);
}

export function deactivate(): void {
	// 阶段 1 会在此处回收 RPC 子进程（含进程树）与遗留的临时目录。
	// 目前没有需要清理的资源。
	logger.debug("Tuack extension deactivating");
}
