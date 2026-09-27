/**
 * 子进程封装测试，真 spawn 不 mock：stdio 往返、秒退识别、进程树 kill、stderr 采集、
 * 遗留临时目录清理。
 */

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import { LocalErrorCode, TuackRpcError, isRpcError } from "../../../rpc/errors";
import { RpcPool, createProcessEndpointFactory } from "../../../rpc/pool";
import type { RpcEvent } from "../../../rpc/protocol";
import {
	STALE_TEMP_PREFIXES,
	cleanupStaleTempDirs,
	diagnoseQuickExit,
	isProcessAlive,
	killProcessTree,
	renderQuickExitDiagnosis,
	spawnRpcProcess,
	type RpcExitInfo,
} from "../../../core/process";

let root = "";
let serverScript = "";
const spawned: { dispose: () => Promise<unknown> }[] = [];

beforeAll(async () => {
	root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tuack-process-test-"));
	serverScript = path.join(root, "fake-rpc-server.cjs");
	await fs.promises.writeFile(serverScript, FAKE_SERVER_SOURCE, "utf8");
});

afterAll(async () => {
	for (const handle of spawned.splice(0)) {
		await handle.dispose().catch(() => undefined);
	}
	await fs.promises.rm(root, { recursive: true, force: true });
});

const FAKE_SERVER_SOURCE = `
const readline = require("node:readline");
process.stderr.write("fake-server-ready\\n");
const rl = readline.createInterface({ input: process.stdin });
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) { return; }
  let msg;
  try { msg = JSON.parse(line); } catch { process.stdout.write("这不是 JSON\\n"); return; }
  if (msg.method === "exit") { process.exit(0); }
  if (msg.id === undefined) { return; }
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "0.1", serverInfo: { name: "fake-tuack-ng-rpc", version: "9.9.9" }, capabilities: ["workspace", "config", "problem", "run", "ren"] } });
      break;
    case "workspace/open":
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "s-1", workspace: { uri: msg.params.uri }, contest: { name: "demo", days: ["day1"], uri: "file:///contest" } } });
      break;
    case "config/get":
      send({ jsonrpc: "2.0", id: msg.id, result: { revision: 0, config: {}, path: "conf.json", uri: "file:///contest/conf.json" } });
      break;
    case "run/create":
      send({ jsonrpc: "2.0", method: "run/started", params: { seq: 1, sessionId: "s-1", runId: "r-1", problem: msg.params.problem, target: msg.params.target, tester: "std" } });
      send({ jsonrpc: "2.0", method: "run/output", params: { seq: 2, sessionId: "s-1", runId: "r-1", testId: null, channel: "compiler", text: "compiling" } });
      send({ jsonrpc: "2.0", method: "run/ready", params: { seq: 3, sessionId: "s-1", runId: "r-1" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { runId: "r-1" } });
      break;
    case "run/judge":
      send({ jsonrpc: "2.0", id: msg.id, result: { testId: msg.params.testId, status: "AC", timeMs: 12, memoryBytes: 2048, message: "", score: 1, fullScore: 1 } });
      break;
    case "run/score":
      send({ jsonrpc: "2.0", id: msg.id, result: { judged: 1, total: 1, report: { groups: [{ id: 1, earned: 1, full: 1 }], total: 1, fullScore: 1 } } });
      break;
    case "ren/run":
      send({ jsonrpc: "2.0", method: "ren/started", params: { seq: 1, sessionId: "s-1", taskId: "t-1", template: msg.params.template, scope: msg.params.scope } });
      send({ jsonrpc: "2.0", method: "ren/progress", params: { seq: 2, sessionId: "s-1", taskId: "t-1", done: 1, total: 1, item: "day1" } });
      send({ jsonrpc: "2.0", id: msg.id, result: { taskId: "t-1" } });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
});
`;

function spawnServer(extra?: { probedAssetsDirs?: string[] }) {
	const process_ = spawnRpcProcess({
		command: process.execPath,
		args: [serverScript],
		clientName: "process-test",
		clientVersion: "0.0.1",
		probedAssetsDirs: extra?.probedAssetsDirs,
	});
	spawned.push(process_);
	return process_;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(target: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (fs.existsSync(target)) {
			return;
		}
		await delay(25);
	}
	throw new Error(`等待文件超时：${target}`);
}

async function waitForDeath(pid: number, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return true;
		}
		await delay(25);
	}
	return !isProcessAlive(pid);
}

describe("spawnRpcProcess + RpcClient（真实 stdio）", () => {
	it("initialize、workspace/open、config/get 全链路，stderr 被采集", async () => {
		const child = spawnServer();
		const init = await child.client.initialize();
		expect(init.protocolVersion).toBe("0.1");
		expect(init.serverInfo.name).toBe("fake-tuack-ng-rpc");

		const opened = await child.client.call("workspace/open", { uri: "file:///contest" });
		expect(opened.sessionId).toBe("s-1");
		expect(opened.contest?.name).toBe("demo");

		const config = await child.client.call("config/get", { sessionId: "s-1" });
		expect(config.revision).toBe(0);
		expect(config.path).toBe("conf.json");

		await delay(50);
		expect(child.stderrText).toContain("fake-server-ready");

		const info = await child.dispose();
		expect(info.code).toBe(0);
		// 优雅回收成功后客户端停在 closed，而不是 dead
		expect(child.client.state).toBe("closed");
		expect(child.isRunning).toBe(false);
	});

	it("dispose 幂等；已退出的进程再 dispose 直接返回临终信息", async () => {
		const child = spawnServer();
		await child.client.initialize();
		const first = await child.dispose();
		const second = await child.dispose();
		expect(second).toBe(first);
	});

	it("池 + 真实进程工厂：workspace/open 后 config/reload，ren/run 的早到事件被回放并命名空间化", async () => {
		const pool = new RpcPool({
			workspaceUri: "file:///contest",
			p2IdleTimeoutMs: 0,
			createEndpoint: createProcessEndpointFactory({
				command: process.execPath,
				args: [serverScript],
				clientName: "pool-test",
				clientVersion: "0.0.1",
			}),
		});
		const events: RpcEvent[] = [];
		pool.onEvent((event) => events.push(event));

		const configPromise = pool.call("config/get", { sessionId: "stale" });
		const task = await pool.call("ren/run", { sessionId: "stale", template: "default", scope: "contest" });
		await configPromise;

		expect(task.taskId).toBe("p1:t-1");
		// ren/started 与 ren/progress 先于响应发出：先缓冲，响应到达后按序回放
		expect(events.map((event) => event.method)).toEqual(["ren/started", "ren/progress"]);
		expect(events[0]).toMatchObject({ taskId: "p1:t-1" });
		expect(pool.controlSessionId()).toBe("s-1");

		await pool.dispose();
		expect(pool.controlEndpoint).toBeUndefined();
	});

	it("两进程端到端：P1 常驻配置 + P2 按需评测，run/started 早到事件回放，回收后 runId 失效", async () => {
		const pool = new RpcPool({
			workspaceUri: "file:///contest",
			p2IdleTimeoutMs: 0,
			createEndpoint: createProcessEndpointFactory({
				command: process.execPath,
				args: [serverScript],
				clientName: "e2e",
				clientVersion: "0.0.1",
			}),
		});
		const events: RpcEvent[] = [];
		pool.onEvent((event) => events.push(event));

		// 1) 控制面先起来，只 spawn P1
		const config = await pool.call("config/get", { sessionId: "stale" });
		expect(config.revision).toBe(0);
		expect(pool.controlEndpoint).toBeDefined();
		expect(pool.hasEvaluation).toBe(false);

		// 2) 评测面按需 spawn；run/started 等事件先于 runId 响应
		const created = await pool.call("run/create", { sessionId: "stale", problem: "day1/p1", target: "data" });
		expect(created.runId).toBe("p2:1:r-1");
		expect(pool.hasEvaluation).toBe(true);
		expect(events.map((event) => event.method)).toEqual(["run/started", "run/output", "run/ready"]);
		expect(events[0]).toMatchObject({ runId: "p2:1:r-1", problem: "day1/p1" });

		// 3) 逐点权威结果来自 run/judge 的响应
		const judged = await pool.call("run/judge", { sessionId: "stale", runId: created.runId, testId: "1" });
		expect(judged).toMatchObject({ testId: "1", status: "AC", score: 1 });

		const score = await pool.call("run/score", { sessionId: "stale", runId: created.runId });
		expect(score.report.total).toBe(1);

		// 4) 回收 P2 后，它的 runId 不再可路由（run 只活在该进程内存里）
		await pool.recycleEvaluation("test");
		const error = await pool.call("run/judge", { sessionId: "stale", runId: created.runId, testId: "1" }).catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.ProcessExited)).toBe(true);
		// P1 仍在
		expect(pool.controlEndpoint).toBeDefined();
		expect((await pool.call("config/get", { sessionId: "stale" })).revision).toBe(0);

		await pool.dispose();
	});
});

describe("秒退识别（assets/langs.json 缺失）", () => {
	it("stdout 零字节 + stderr 有 langs.json + 退出码 1 时立刻给出诊断（不等 initialize 超时）", async () => {
		const probed = ["/ws/assets", "/home/u/.local/share/tuack-ng", "/usr/share/tuack-ng"];
		const started = Date.now();
		const child = spawnRpcProcess({
			command: process.execPath,
			args: ["-e", 'process.stderr.write("Error: 找不到 langs.json\\n"); process.exit(1);'],
			clientName: "process-test",
			clientVersion: "0.0.1",
			// 故意把 initialize 超时设得很长：秒退必须靠 close 事件识别，而不是靠超时
			initializeTimeoutMs: 30_000,
			probedAssetsDirs: probed,
		});
		spawned.push(child);

		const error = (await child.client.initialize().catch((e: unknown) => e)) as TuackRpcError;
		expect(isRpcError(error, LocalErrorCode.ProcessExited)).toBe(true);
		// 关键：远早于 30s 的 initialize 超时
		expect(Date.now() - started).toBeLessThan(3000);

		const data = error.dataAs<{
			fastExit: boolean;
			stdoutBytes: number;
			stderr: string;
			diagnosis: { kind: string; summary: string; advice: string[] };
		}>();
		expect(data?.fastExit).toBe(true);
		expect(data?.stdoutBytes).toBe(0);
		expect(data?.stderr).toContain("找不到 langs.json");
		expect(data?.diagnosis.kind).toBe("assets-missing");
		expect(error.message).toContain("启动即退出");
		const advice = data?.diagnosis.advice.join("\n") ?? "";
		expect(advice).toContain("tuack.assetsPath");
		expect(advice).toContain("/usr/share/tuack-ng");
		// 「不可降级」只写在 summary 里
		expect(data?.diagnosis.summary).toContain("不可降级");

		const info = await child.exited;
		expect(info.code).toBe(1);
		expect(info.fastExit).toBe(true);
		expect(info.diagnosis?.kind).toBe("assets-missing");
		expect(renderQuickExitDiagnosis(info)).toContain("langs.json");
	});

	it("spawn 失败（ENOENT）报 SpawnFailed，且是立刻失败", async () => {
		const started = Date.now();
		const child = spawnRpcProcess({ command: path.join(root, "definitely-missing-binary") });
		spawned.push(child);
		const error = await child.client.initialize().catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.SpawnFailed)).toBe(true);
		expect(Date.now() - started).toBeLessThan(3000);
		const info = await child.exited;
		expect(info.diagnosis?.kind).toBe("binary-missing");
		expect(info.spawnError).toBeDefined();
	});

	it("普通异常退出（无 langs 关键字）归为 unknown 诊断，仍带 stderr 尾巴", async () => {
		const child = spawnRpcProcess({
			command: process.execPath,
			args: ["-e", 'process.stderr.write("boom\\n"); process.exit(3);'],
			initializeTimeoutMs: 30_000,
		});
		spawned.push(child);
		const error = await child.client.initialize().catch((e: unknown) => e);
		expect(isRpcError(error, LocalErrorCode.ProcessExited)).toBe(true);
		const info = await child.exited;
		expect(info.fastExit).toBe(true);
		expect(info.diagnosis?.kind).toBe("unknown");
		expect(info.diagnosis?.advice.join("\n")).toContain("boom");
		expect(renderQuickExitDiagnosis(info)).toContain("code=3");
	});
});

describe("进程树 kill", () => {
	it.skipIf(process.platform === "win32")("kill 会带走孙进程（POSIX 进程组）", async () => {
		const pidFile = path.join(root, `pids-${Date.now()}.json`);
		const script = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
setInterval(() => {}, 1000);
`;
		const child = spawnRpcProcess({
			command: process.execPath,
			args: ["-e", script],
			env: { PID_FILE: pidFile },
		});
		spawned.push(child);
		await waitForFile(pidFile);
		const pids = JSON.parse(await fs.promises.readFile(pidFile, "utf8")) as { parent: number; grandchild: number };
		expect(pids.parent).toBe(child.pid);
		expect(isProcessAlive(pids.grandchild)).toBe(true);

		await child.kill();
		expect(await waitForDeath(pids.parent)).toBe(true);
		expect(await waitForDeath(pids.grandchild)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("killProcessTree 对已死进程是 no-op", async () => {
		const child = nodeSpawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		const pid = child.pid as number;
		await new Promise((resolve) => child.once("close", resolve));
		await expect(killProcessTree(pid, { detached: true, timeoutMs: 200 })).resolves.toBeUndefined();
	});
});

describe("diagnoseQuickExit", () => {
	function exitInfo(partial: Partial<RpcExitInfo>): RpcExitInfo {
		return {
			pid: 1,
			code: 1,
			signal: null,
			startedAt: 0,
			elapsedMs: 10,
			stdoutBytes: 0,
			messagesReceived: 0,
			stderr: "",
			fastExit: true,
			...partial,
		};
	}

	it("stderr 命中 langs.json 判为 assets-missing，并列出已探测目录", () => {
		const diagnosis = diagnoseQuickExit(exitInfo({ stderr: "Error: 找不到 langs.json\n" }), ["/a", "/b"]);
		expect(diagnosis.kind).toBe("assets-missing");
		expect(diagnosis.advice.join("\n")).toContain("/a、/b");
	});

	it("stderr 命中「找不到」判为 binary-missing", () => {
		const diagnosis = diagnoseQuickExit(exitInfo({ stderr: "Error: 找不到资源\n" }));
		expect(diagnosis.kind).toBe("binary-missing");
	});

	it("被信号杀死判为 signaled", () => {
		const diagnosis = diagnoseQuickExit(exitInfo({ signal: "SIGKILL", code: null }));
		expect(diagnosis.kind).toBe("signaled");
	});

	it("spawnError ENOENT 判为 binary-missing，指引指向 tuack.rpcPath", () => {
		const diagnosis = diagnoseQuickExit(exitInfo({ spawnError: new Error("spawn tuack-ng-rpc ENOENT"), code: null }));
		expect(diagnosis.kind).toBe("binary-missing");
		expect(diagnosis.advice.join("\n")).toContain("tuack.rpcPath");
	});

	it("什么都没有判为 unknown，且提示直接在终端复现", () => {
		const diagnosis = diagnoseQuickExit(exitInfo({}));
		expect(diagnosis.kind).toBe("unknown");
		expect(diagnosis.advice.join("\n")).toContain("终端");
	});
});

describe("cleanupStaleTempDirs", () => {
	it("清理够旧的遗留目录；跳过很新的、pid 存活的、非目录的", async () => {
		const tmpRoot = await fs.promises.mkdtemp(path.join(root, "tmp-cleanup-"));
		const staleRunner = path.join(tmpRoot, "tuack-ng-runner-abc123");
		const staleRenDay = path.join(tmpRoot, "tuack-ng-ren-day-xyz");
		const freshChecker = path.join(tmpRoot, "tuack-ng-checker-fresh");
		const livePidDir = path.join(tmpRoot, "tuack-ng-ren-4242");
		const aFile = path.join(tmpRoot, "tuack-ng-runner-file");
		const unrelated = path.join(tmpRoot, "some-other-dir");
		for (const dir of [staleRunner, staleRenDay, freshChecker, livePidDir, unrelated]) {
			await fs.promises.mkdir(dir, { recursive: true });
		}
		await fs.promises.writeFile(aFile, "x");

		const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
		await fs.promises.utimes(staleRunner, twoHoursAgo, twoHoursAgo);
		await fs.promises.utimes(staleRenDay, twoHoursAgo, twoHoursAgo);
		await fs.promises.utimes(livePidDir, twoHoursAgo, twoHoursAgo);

		const result = await cleanupStaleTempDirs({
			tmpDir: tmpRoot,
			minAgeMs: 60 * 60 * 1000,
			isPidAlive: (pid) => pid === 4242,
		});

		expect(result.removed.sort()).toEqual([staleRenDay, staleRunner].sort());
		expect(fs.existsSync(staleRunner)).toBe(false);
		expect(fs.existsSync(freshChecker)).toBe(true);
		expect(fs.existsSync(livePidDir)).toBe(true);
		expect(fs.existsSync(aFile)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
		expect(result.skipped.some((entry) => entry.path === freshChecker && entry.reason.includes("太新"))).toBe(true);
		expect(result.skipped.some((entry) => entry.path === livePidDir && entry.reason.includes("4242"))).toBe(true);
		expect(result.skipped.some((entry) => entry.path === aFile && entry.reason.includes("不是普通目录"))).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("dryRun 只报告不删除", async () => {
		const tmpRoot = await fs.promises.mkdtemp(path.join(root, "tmp-dryrun-"));
		const stale = path.join(tmpRoot, "tuack-ng-runner-old");
		await fs.promises.mkdir(stale, { recursive: true });
		const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
		await fs.promises.utimes(stale, twoHoursAgo, twoHoursAgo);
		const result = await cleanupStaleTempDirs({ tmpDir: tmpRoot, minAgeMs: 60_000, dryRun: true });
		expect(result.removed).toEqual([]);
		expect(result.skipped.some((entry) => entry.path === stale && entry.reason === "dryRun")).toBe(true);
		expect(fs.existsSync(stale)).toBe(true);
	});

	it("不存在的 temp 目录只记 error，不抛", async () => {
		const result = await cleanupStaleTempDirs({ tmpDir: path.join(root, "no-such-tmp") });
		expect(result.removed).toEqual([]);
		expect(result.errors).toHaveLength(1);
	});

	it("前缀集合覆盖 runner / checker / ren-", () => {
		expect(STALE_TEMP_PREFIXES).toEqual(["tuack-ng-runner-", "tuack-ng-checker-", "tuack-ng-ren-"]);
	});
});
