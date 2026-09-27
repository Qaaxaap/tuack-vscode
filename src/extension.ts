/**
 * 扩展入口。
 *
 * 职责分工（各阶段的接入点已在下方标注）：
 * - 阶段 0（Lead）：激活、日志、工作区事件、命令注册骨架。
 * - 阶段 1：`rpc/` 的进程与传输层（RpcPool / RpcClient）在此装配。
 * - 阶段 2：预览控制器与 webview 宿主（`features/preview/*`）。
 * - 阶段 3：结构树 provider 与 conf.json 诊断。
 * - 阶段 4：测试控制器与 CLI 通道。
 * - 阶段 5：环境诊断面板、语言支持。
 *
 * 注意：本文件只做「组装」，不承载具体业务逻辑。
 * 用户可见字符串一律走 `vscode.l10n.t()`（见 `l10n/`；控制器拿到的 `translate` 就是它）。
 */

import * as vscode from "vscode";

import { initLog, logger, outputChannel } from "./core/log";
import { resolveTuackRpc } from "./core/binaries";
import { assetsEnvForDir, buildAssetsEnv, inspectAssets, probedAssetsPaths } from "./core/assets";
import { cleanupStaleTempDirs } from "./core/process";
import { RpcPool, createProcessEndpointFactory } from "./rpc/pool";
import type { MethodName, MethodParams, MethodResult, SessionId } from "./rpc/protocol";
import type { RpcCallOptions } from "./rpc/client";
import { PreviewController, type PreviewRpc } from "./features/preview/controller";
import {
	createPreviewHostFactory,
	createVscodePreviewEnvironment,
	registerPreviewSerializer,
} from "./features/preview/panel";

/** 供 `deactivate()` 回收（模块级，因为 deactivate 拿不到 activate 的闭包）。 */
let activeController: PreviewController | undefined;
let activePool: RpcPool | undefined;

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

	// 上一实例崩溃 / 被强杀时可能留下 `tuack-ng-*` 临时目录；启动时顺手清理（保守策略见 process.ts）。
	void cleanupStaleTempDirs()
		.then((result) => {
			if (result.removed.length > 0) {
				logger.info(`[preview] 启动清理：移除 ${result.removed.length} 个遗留临时目录。`);
			}
		})
		.catch((error: unknown) => {
			logger.warn(`[preview] 启动清理遗留临时目录失败：${describe(error)}`);
		});

	// ── RPC 池装配：惰性 spawn，避免「只是打开一个工程」就拉起子进程 ──────────
	//
	// 池在构造时就固定 `workspaceUri`，而竞赛工程根要等题面定位出来才知道，
	// 所以这里用 `ensurePool()` 做「按需创建 / 换根重建」，控制器只依赖 `PreviewRpc` 接口。
	interface PoolHandle {
		pool: RpcPool;
		workspaceUri: string;
	}
	let handle: PoolHandle | undefined;
	let handlePromise: Promise<PoolHandle> | undefined;

	const createPool = async (workspaceUri: string, contestRootFsPath: string): Promise<RpcPool> => {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const tuackConfig = vscode.workspace.getConfiguration("tuack");
		const rpcPath = tuackConfig.get<string | null>("rpcPath");
		const assetsPath = tuackConfig.get<string | null>("assetsPath");

		const binary = await resolveTuackRpc({
			configuredPath: rpcPath,
			workspaceRoot,
			contestRoot: contestRootFsPath,
		});
		const assets = await inspectAssets({ overridePath: assetsPath, workspaceRoot });

		// tuack-ng 只在 `data_local_dir()/tuack-ng` 里找 langs.json；用 XDG_DATA_HOME / LOCALAPPDATA 注入。
		let assetsEnv: NodeJS.ProcessEnv = {};
		if (assets.dir !== null) {
			const direct = buildAssetsEnv(assets.dir);
			if (direct.injected) {
				assetsEnv = direct.env;
			} else {
				const viaShim = await assetsEnvForDir(assets.dir, { shimRoot: context.globalStorageUri.fsPath });
				if (viaShim.injected) {
					assetsEnv = viaShim.env;
				} else {
					logger.warn(
						`[preview] assets 注入失败（${viaShim.reason ?? direct.reason ?? "未知原因"}）；` +
							"tuack-ng-rpc 缺少 langs.json 会启动即退出。",
					);
				}
			}
		} else {
			logger.warn("[preview] 未找到含 langs.json 的 assets 目录；tuack-ng-rpc 会在启动时退出（硬阻塞）。");
		}

		const createEndpoint = createProcessEndpointFactory({
			command: binary.path,
			cwd: contestRootFsPath,
			env: assetsEnv,
			clientName: "tuack-vscode",
			clientVersion: version,
			probedAssetsDirs: probedAssetsPaths(assets),
			onStderr: (namespace, text) => {
				const trimmed = text.trimEnd();
				if (trimmed.length > 0) {
					logger.debug(`[rpc ${namespace}] ${trimmed}`);
				}
			},
			onExit: (namespace, info) => {
				logger.debug(`[rpc ${namespace}] 进程退出：code=${info.code ?? "null"} signal=${info.signal ?? "null"}`);
			},
		});

		logger.info(`[preview] 装配 RPC 池：${binary.path}（工程根 ${contestRootFsPath}）。`);
		return new RpcPool({ workspaceUri, createEndpoint });
	};

	const ensurePool = async (contestRootFsPath: string): Promise<RpcPool> => {
		const workspaceUri = vscode.Uri.file(contestRootFsPath).toString();
		if (handlePromise === undefined) {
			handlePromise = createPool(workspaceUri, contestRootFsPath).then(
				(pool) => {
					handle = { pool, workspaceUri };
					activePool = pool;
					return handle;
				},
				(error: unknown) => {
					// 失败不缓存：用户改完 tuack.rpcPath 后重试应当真的重试。
					handlePromise = undefined;
					throw error;
				},
			);
		}

		const created = await handlePromise;
		if (created.workspaceUri !== workspaceUri) {
			// 用户在另一个竞赛工程里打开了预览：回收旧池（含 P1/P2 进程树），为新根重建。
			logger.info("[preview] 竞赛工程根变化，回收旧 RPC 池并重建。");
			handlePromise = undefined;
			handle = undefined;
			activePool = undefined;
			await created.pool.dispose();
			return ensurePool(contestRootFsPath);
		}
		return created.pool;
	};

	const rpc: PreviewRpc = {
		async openWorkspace(contestRootFsPath: string): Promise<void> {
			await ensurePool(contestRootFsPath);
		},
		call<M extends MethodName>(
			method: M,
			params: MethodParams<M>,
			options?: RpcCallOptions,
		): Promise<MethodResult<M>> {
			const current = handle;
			if (current === undefined) {
				return Promise.reject(new Error("Tuack: RPC pool is not ready (openWorkspace was not called)."));
			}
			return current.pool.call(method, params, options);
		},
		controlSessionId(): SessionId | undefined {
			return handle?.pool.controlSessionId();
		},
	};

	// ── 预览控制器与面板 ────────────────────────────────────────────────────
	const environment = createVscodePreviewEnvironment(context);
	const hostFactory = createPreviewHostFactory({
		extensionUri: context.extensionUri,
		memento: context.workspaceState,
	});
	const controller = new PreviewController({ rpc, env: environment, hosts: hostFactory });
	activeController = controller;

	context.subscriptions.push(
		controller,
		registerPreviewSerializer({
			context,
			extensionUri: context.extensionUri,
			target: controller,
		}),
	);

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

		// ── 预览命令（阶段 2b） ─────────────────────────────────────────────
		vscode.commands.registerCommand("tuack.preview.show", () => controller.showActive({ beside: false })),

		vscode.commands.registerCommand("tuack.preview.showToSide", () => controller.showActive({ beside: true })),

		vscode.commands.registerCommand("tuack.preview.refresh", () => {
			controller.refresh();
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

export async function deactivate(): Promise<void> {
	logger.debug("Tuack extension deactivating");

	activeController?.dispose();
	activeController = undefined;

	const pool = activePool;
	activePool = undefined;
	if (pool !== undefined) {
		await pool.dispose();
	}

	try {
		const result = await cleanupStaleTempDirs();
		logger.debug(`[preview] 退出清理：移除 ${result.removed.length} 个遗留临时目录，跳过 ${result.skipped.length} 个。`);
	} catch (error) {
		logger.warn(`[preview] 退出清理遗留临时目录失败：${describe(error)}`);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
