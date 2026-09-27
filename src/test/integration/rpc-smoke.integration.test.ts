/**
 * 真实 `tuack-ng-rpc` 二进制的端到端冒烟（**默认跳过**）。
 *
 * 与 `src/test/unit/**` 的区别：单测用「假 NDJSON 服务端」，本文件必须连**真二进制**，
 * 因此只在设置了环境变量时运行（`pnpm run test:unit` 不会碰到它）：
 *
 * - `TUACK_RPC_BIN`：`tuack-ng-rpc` 可执行文件绝对路径（**必需**）
 * - `TUACK_NG_BIN`：`tuack-ng` CLI 绝对路径；给了就现造一个真实竞赛工程
 * - `TUACK_FIXTURE`：已存在的竞赛工程根目录（与上面二选一；会被复制进临时目录后再改）
 * - `TUACK_ASSETS_DIR`：含 `langs.json` 的 assets 目录；给了就通过 `core/assets.ts`
 *   的 shim + `XDG_DATA_HOME` 注入（见 `README.md`）
 *
 * 运行方式（仓库根）：
 * ```bash
 * TUACK_RPC_BIN=/abs/tuack-ng-rpc TUACK_NG_BIN=/abs/tuack-ng \
 *   pnpm exec vitest run --config src/test/integration/vitest.integration.config.ts
 * ```
 *
 * 断言里刻意**钉死**实测到的线上形态（包括与 `protocol.ts` / `config/schema` 假设不一致的地方），
 * 详见 `.cache/research/rpc-smoke-report.md`。被测到的差异一旦被上游修掉，本文件会红，
 * 这正是它作为「差分冒烟」的价值。
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 与单测一致：`core/log` 依赖 vscode，测试里替换成空实现。
vi.mock("../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import { assetsEnvForDir } from "../../core/assets";
import { spawnRpcProcess, type RpcProcess } from "../../core/process";
import { RpcClient } from "../../rpc/client";
import { ErrorCode, PROTOCOL_VERSION, type JudgeResult, type RenGetResult, type RpcEvent, type RunGetResult } from "../../rpc/protocol";
import { TuackRpcError } from "../../rpc/errors";
import { NdjsonTransport } from "../../rpc/transport";
import { RpcPool, createProcessEndpointFactory } from "../../rpc/pool";

const RPC_BIN = process.env["TUACK_RPC_BIN"];
const NG_BIN = process.env["TUACK_NG_BIN"];
const FIXTURE_DIR = process.env["TUACK_FIXTURE"];
const ASSETS_DIR = process.env["TUACK_ASSETS_DIR"];

/** 需要真二进制 + 一个真实工程（现造或用现成的）。 */
const enabled = Boolean(RPC_BIN) && Boolean(NG_BIN ?? FIXTURE_DIR);

const DAY = "day1";
const PROBLEM = "p1";
const PROBLEM_SCOPE = `${DAY}/${PROBLEM}`;

const CLIENT_INFO = { clientName: "tuack-vscode-smoke", clientVersion: "0.1.0" };

const SENTINEL_RE = /\[[0-9a-f]+-L\d+\]/;

/** `ren/preview` 的实测行为：每一行开头的一个空格都会被吃掉（上游 `parse_sentinels` 的 `strip_prefix(' ')`）。 */
function stripOneLeadingSpacePerLine(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.startsWith(" ") ? line.slice(1) : line))
		.join("\n");
}

/** 默认 `file-io`（继承后为 true 时）必须读写 `p1.in` / `p1.out`。 */
const FILE_IO_SOLUTION = `#include <cstdio>
int main() {
    FILE *in = fopen("${PROBLEM}.in", "r");
    FILE *out = fopen("${PROBLEM}.out", "w");
    if (!in || !out) return 2;
    long long a = 0, b = 0;
    if (fscanf(in, "%lld %lld", &a, &b) != 2) { fclose(in); fclose(out); return 1; }
    fprintf(out, "%lld\\n", a + b);
    fclose(in); fclose(out);
    return 0;
}
`;

/** `file-io: false`（kebab！）时走 stdio。 */
const STDIO_SOLUTION = `#include <cstdio>
int main() { long long a = 0, b = 0; if (scanf("%lld %lld", &a, &b) != 2) return 1; printf("%lld\\n", a + b); return 0; }
`;

const RE_SOLUTION = `#include <cstdio>
int main() { return 1; }
`;

const TLE_SOLUTION = `int main() { volatile long long x = 0; for (;;) { x += 1; } return (int)x; }
`;

const DATA_POINTS: ReadonlyArray<readonly [number, string, string]> = [
	[1, "1 2\n", "3\n"],
	[2, "10 20\n", "30\n"],
	[3, "100 200\n", "300\n"],
];

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCli(cliBin: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
	execFileSync(cliBin, [...args], { cwd, env, stdio: "pipe" });
}

function writeFixtureSources(problemDir: string): void {
	fs.mkdirSync(path.join(problemDir, "data"), { recursive: true });
	fs.mkdirSync(path.join(problemDir, "sample"), { recursive: true });
	for (const [id, input, answer] of DATA_POINTS) {
		fs.writeFileSync(path.join(problemDir, "data", `${id}.in`), input);
		fs.writeFileSync(path.join(problemDir, "data", `${id}.ans`), answer);
	}
	fs.writeFileSync(path.join(problemDir, "sample", "a.in"), "5 7\n");
	fs.writeFileSync(path.join(problemDir, "sample", "a.ans"), "12\n");
	fs.writeFileSync(path.join(problemDir, "std.cpp"), FILE_IO_SOLUTION);
	fs.writeFileSync(path.join(problemDir, "stdio.cpp"), STDIO_SOLUTION);
	fs.writeFileSync(path.join(problemDir, "re.cpp"), RE_SOLUTION);
	fs.writeFileSync(path.join(problemDir, "tle.cpp"), TLE_SOLUTION);
}

/** 用真实 CLI 造工程（`gen contest/day/problem` + `gen data -y` + `gen code -y`）。 */
function generateFixture(cliBin: string, dest: string, env: NodeJS.ProcessEnv): void {
	runCli(cliBin, ["gen", "contest", "demo"], dest, env);
	const contestDir = path.join(dest, "demo");
	runCli(cliBin, ["gen", "day", DAY], contestDir, env);
	const dayDir = path.join(contestDir, DAY);
	runCli(cliBin, ["gen", "problem", PROBLEM], dayDir, env);
	const problemDir = path.join(dayDir, PROBLEM);
	writeFixtureSources(problemDir);
	runCli(cliBin, ["gen", "data", "-y"], problemDir, env);
	runCli(cliBin, ["gen", "code", "-y"], problemDir, env);
}

async function prepareWorkRoot(prefix: string): Promise<{ workRoot: string; contestRoot: string; env: NodeJS.ProcessEnv; assets: string[] | undefined }> {
	const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	let env: NodeJS.ProcessEnv = process.env;
	let assets: string[] | undefined;
	if (ASSETS_DIR) {
		const injected = await assetsEnvForDir(ASSETS_DIR, { shimRoot: path.join(workRoot, "shim") });
		expect(injected.injected, injected.reason ?? "assets 注入失败").toBe(true);
		env = injected.env;
		assets = [ASSETS_DIR];
	}
	const contestRoot = path.join(workRoot, "demo");
	if (FIXTURE_DIR) {
		fs.cpSync(FIXTURE_DIR, contestRoot, { recursive: true });
	} else {
		generateFixture(NG_BIN as string, workRoot, env);
	}
	return { workRoot, contestRoot, env, assets };
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具：等待 run 就绪 / 单点评测 / 原始连接（绕过客户端生命周期强制）
// ─────────────────────────────────────────────────────────────────────────────

async function waitForRunReady(client: RpcClient, sessionId: string, runId: string, timeoutMs = 60_000): Promise<RunGetResult> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshot = await client.call("run/get", { sessionId, runId });
		if (snapshot.state !== "preparing" || Date.now() > deadline) {
			return snapshot;
		}
		await delay(100);
	}
}

async function createRun(client: RpcClient, sessionId: string, tester?: string): Promise<string> {
	const created = await client.call(
		"run/create",
		tester === undefined
			? { sessionId, problem: PROBLEM_SCOPE, target: "data" }
			: { sessionId, problem: PROBLEM_SCOPE, target: "data", tester },
	);
	await waitForRunReady(client, sessionId, created.runId);
	return created.runId;
}

async function judgePoint(client: RpcClient, sessionId: string, runId: string, testId: string): Promise<JudgeResult> {
	return client.call("run/judge", { sessionId, runId, testId }, { timeoutMs: 120_000 });
}

interface RawConnection {
	client: RpcClient;
	dispose: () => Promise<void>;
}

/**
 * 直接接线 `NdjsonTransport` + `RpcClient`，关掉客户端的生命周期/能力门控，
 * 这样服务端自己的 `-32600` / `-32601` 才能被测到（`core/process.ts` 的封装不给这个口子）。
 */
function connectRaw(env: NodeJS.ProcessEnv): RawConnection {
	const child = spawn(RPC_BIN as string, [], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", () => undefined);
	child.stdin.on("error", () => undefined);

	let client!: RpcClient;
	const transport = new NdjsonTransport({
		input: child.stdout,
		output: child.stdin,
		onMessage: (message: Record<string, unknown>) => client.handleMessage(message),
	});
	client = new RpcClient({
		transport,
		clientName: CLIENT_INFO.clientName,
		clientVersion: CLIENT_INFO.clientVersion,
		enforceLifecycle: false,
		enforceCapabilities: false,
	});

	return {
		client,
		dispose: async () => {
			try {
				transport.writeLine(JSON.stringify({ jsonrpc: "2.0", method: "exit" }));
			} catch {
				// 进程可能已退出。
			}
			child.stdin.end();
			await delay(200);
			if (child.exitCode === null) {
				child.kill("SIGKILL");
			}
		},
	};
}

describe.skipIf(!enabled)("tuack-ng-rpc 真实二进制冒烟", () => {
	let workRoot = "";
	let contestRoot = "";
	let workspaceUri = "";
	let childEnv: NodeJS.ProcessEnv = process.env;
	let probedAssetsDirs: readonly string[] | undefined;
	let proc: RpcProcess;
	let sessionId = "";
	const events: RpcEvent[] = [];
	const statementPath = (): string => path.join(contestRoot, DAY, PROBLEM, "statement.md");

	beforeAll(async () => {
		const prepared = await prepareWorkRoot("tuack-vscode-smoke-");
		workRoot = prepared.workRoot;
		contestRoot = prepared.contestRoot;
		childEnv = prepared.env;
		probedAssetsDirs = prepared.assets;
		workspaceUri = `file://${contestRoot}`;
	});

	afterAll(() => {
		if (workRoot) {
			fs.rmSync(workRoot, { recursive: true, force: true });
		}
	});

	beforeAll(async () => {
		proc = spawnRpcProcess({
			command: RPC_BIN as string,
			env: childEnv,
			probedAssetsDirs,
			...CLIENT_INFO,
			initializeTimeoutMs: 30_000,
			defaultTimeoutMs: 30_000,
		});
		proc.client.onEvent((event) => events.push(event));
		await proc.client.initialize();
		const opened = await proc.client.call("workspace/open", { uri: workspaceUri });
		sessionId = opened.sessionId;
	});

	afterAll(async () => {
		if (proc) {
			await proc.dispose();
		}
	});

	it("initialize：protocolVersion / serverInfo / capabilities 与 protocol.ts 一致", () => {
		expect(proc.client.protocolVersion).toBe(PROTOCOL_VERSION);
		expect(proc.client.serverInfo?.name).toBeTruthy();
		expect([...(proc.client.capabilities ?? [])].sort()).toEqual(["config", "problem", "ren", "run", "workspace"]);
	});

	it("workspace/open：识别真实工程并给出 contest", async () => {
		const opened = await proc.client.call("workspace/open", { uri: workspaceUri });
		expect(opened.workspace.uri).toBe(workspaceUri);
		expect(opened.contest).not.toBeNull();
		expect(opened.contest?.name).toBe("demo");
		expect(opened.contest?.days).toContain(DAY);
		expect(opened.contest?.uri).toBe(workspaceUri);
		await proc.client.call("workspace/close", { sessionId: opened.sessionId });
	});

	it("config/get：contest / day / problem 三层都能读，带空格的键原样返回", async () => {
		const contest = await proc.client.call("config/get", { sessionId, scope: "contest" });
		expect(contest.path).toBe("conf.json");
		expect(contest.uri).toBe(`${workspaceUri}/conf.json`);
		expect(contest.revision).toBe(0);
		expect(contest.config["short title"]).toBeTruthy();

		const day = await proc.client.call("config/get", { sessionId, scope: DAY });
		expect(day.path).toBe(`${DAY}/conf.json`);
		expect(Array.isArray(day.config["start time"])).toBe(true);
		expect(Array.isArray(day.config["end time"])).toBe(true);

		const problem = await proc.client.call("config/get", { sessionId, scope: PROBLEM_SCOPE });
		expect(problem.path).toBe(`${DAY}/${PROBLEM}/conf.json`);
		expect(problem.config["time limit"]).toBe(1);
		expect(typeof problem.config["memory limit"]).toBe("string");
	});

	it("problem/list 与 problem/get：bundle 已展开；id 是**数字**（与 protocol.ts 的 string 声明不符）", async () => {
		const list = await proc.client.call("problem/list", { sessionId, scope: "contest" });
		expect(list.problems.map((p) => p.path)).toEqual([PROBLEM_SCOPE]);
		expect(list.problems[0]?.name).toBe(PROBLEM);
		expect(list.problems[0]?.problemType).toBe("program");

		const listedDay = await proc.client.call("problem/list", { sessionId, scope: DAY });
		expect(listedDay.problems.map((p) => p.path)).toEqual([PROBLEM_SCOPE]);

		const detail = (await proc.client.call("problem/get", { sessionId, problem: PROBLEM_SCOPE })).problem;
		expect(detail.timeLimitMs).toBe(1000);
		expect(detail.memoryLimitBytes).toBe(512 * 1024 * 1024);
		expect(detail.path).toBe(PROBLEM_SCOPE);
		expect(detail.data.map((d) => String(d.id))).toEqual(["1", "2", "3"]);

		// ⚠️ 线上 `id` 是 JSON number；`protocol.ts` 声明为 string，而 `run/judge` 又只收 string。
		const rawDataId: unknown = detail.data[0]?.id;
		const rawSampleId: unknown = detail.samples[0]?.id;
		expect(typeof rawDataId, `problem/get.data[].id 实测 ${typeof rawDataId}，protocol.ts 声明 string`).toBe("number");
		expect(typeof rawSampleId, `problem/get.samples[].id 实测 ${typeof rawSampleId}，protocol.ts 声明 string`).toBe("number");
	});

	it("config/schema：三份 schema 的 required/properties 与 schemas/tuack-conf.schema.json 一致", async () => {
		const schema = await proc.client.call("config/schema", undefined);
		const repo = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, "../../../schemas/tuack-conf.schema.json"), "utf8"),
		) as { definitions: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };

		for (const level of ["contest", "day", "problem"] as const) {
			const wire = schema[level] as { $schema?: string; required?: string[]; properties?: Record<string, unknown> };
			expect(wire.$schema).toBe("http://json-schema.org/draft-07/schema#");
			expect([...(wire.required ?? [])].sort()).toEqual([...(repo.definitions[level]?.required ?? [])].sort());
			expect(Object.keys(wire.properties ?? {}).sort()).toEqual(Object.keys(repo.definitions[level]?.properties ?? {}).sort());
		}

		const problem = schema.problem as { required: string[] };
		expect(problem.required).toContain("time limit");
		expect(problem.required).toContain("memory limit");
		// schema 只是「声明」：contest/day 里的 file_io 在真实 FileView 里叫 file-io（见 config/set 用例）。
		expect(Object.keys((schema.contest as { properties: Record<string, unknown> }).properties)).toContain("file_io");
	});

	it("ren/preview：不传 template 也返回 markdown/warnings/lineMap，行号 1 起；行首空格会被吃掉", async () => {
		const original = fs.readFileSync(statementPath(), "utf8");
		try {
			const preview = await proc.client.call("ren/preview", { sessionId, scope: PROBLEM_SCOPE });
			expect(preview.markdown).toContain("## 题目描述");
			expect(preview.markdown).not.toMatch(SENTINEL_RE);
			// 脚手架题面没有缩进行也没有 jinja：展开结果应与文件逐字节一致。
			expect(preview.markdown).toBe(original);
			expect(Array.isArray(preview.warnings)).toBe(true);

			expect(preview.lineMap.length).toBeGreaterThan(0);
			expect(preview.lineMap[0]?.source).toBe(1);
			expect(preview.lineMap[0]?.rendered).toBe(1);
			for (const entry of preview.lineMap) {
				expect(entry.source).toBeGreaterThanOrEqual(1);
				expect(entry.rendered).toBeGreaterThanOrEqual(1);
			}
			const sources = preview.lineMap.map((e) => e.source);
			expect(sources).toEqual([...sources].sort((a, b) => a - b));
			// 实测上界 = statement.md 按 '\n' 切分后的段数（尾换行会多出一条空段）。
			expect(Math.max(...sources)).toBe(original.split("\n").length);

			// ⚠️ 上游差异：每行行首的一个空格会被无条件吃掉（缩进代码块/嵌套列表会被破坏）。
			const indented = "## 题目描述\n\n普通行\n\n  缩进两格的行\n    * 列表项\n\n    code\n";
			fs.writeFileSync(statementPath(), indented);
			const preview2 = await proc.client.call("ren/preview", { sessionId, scope: PROBLEM_SCOPE });
			expect(preview2.markdown).toBe(stripOneLeadingSpacePerLine(indented));
			expect(preview2.markdown).not.toBe(indented);
		} finally {
			fs.writeFileSync(statementPath(), original);
		}
	});

	it("ren/run：异步事件 → ren/get 返回 tmpDir/files，且 tmpDir 永不自动清理", async (ctx) => {
		const template = process.env["TUACK_SMOKE_TEMPLATE"] ?? "markdown";
		let taskId: string;
		try {
			const started = await proc.client.call("ren/run", { sessionId, template, scope: PROBLEM_SCOPE });
			taskId = started.taskId;
		} catch (error) {
			if (error instanceof TuackRpcError && error.code === ErrorCode.InvalidConfigField) {
				ctx.skip();
				return;
			}
			throw error;
		}

		let result: RenGetResult | undefined;
		const deadline = Date.now() + 120_000;
		for (;;) {
			result = await proc.client.call("ren/get", { sessionId, taskId });
			if (result.state !== "running" || Date.now() > deadline) {
				break;
			}
			await delay(250);
		}
		expect(result?.state).toBe("finished");
		expect(result?.template).toBe(template);
		expect(result?.error).toBeNull();
		expect(result?.files.length).toBeGreaterThan(0);

		const renStarted = events.find(
			(e): e is Extract<RpcEvent, { method: "ren/started" }> => e.method === "ren/started" && e.taskId === taskId,
		);
		expect(renStarted?.template).toBe(template);
		expect(events.some((e) => e.method === "ren/finished" && e.taskId === taskId)).toBe(true);

		const tmpDir = result?.tmpDir as string;
		expect(fs.existsSync(tmpDir)).toBe(true);
		for (const file of result?.files ?? []) {
			expect(fs.existsSync(path.join(tmpDir, file.path)), `${file.path} 应存在`).toBe(true);
		}
		// 客户端必须自己删：`TempDir::keep()` 之后没有任何自动清理。
		fs.rmSync(tmpDir, { recursive: true, force: true });
		expect(fs.existsSync(tmpDir)).toBe(false);
	});

	it("run/create → run/judge → run/score：默认 file-io（题解写 p1.out），run/started 早于响应", async () => {
		const detail = (await proc.client.call("problem/get", { sessionId, problem: PROBLEM_SCOPE })).problem;
		expect(detail.fileIo).toBeNull(); // 「未设置」；实际 judge 走 file_io=true 默认值

		let createResolved = false;
		let startedBeforeResponse: boolean | undefined;
		const subscription = proc.client.onEvent((event) => {
			if (event.method === "run/started" && startedBeforeResponse === undefined) {
				startedBeforeResponse = !createResolved;
			}
		});
		const created = await proc.client.call("run/create", { sessionId, problem: PROBLEM_SCOPE, target: "data" });
		createResolved = true;
		subscription.dispose();

		expect(startedBeforeResponse, "run/started 应在 run/create 响应之前到达").toBe(true);
		expect(events.some((e) => e.method === "run/started" && e.runId === created.runId)).toBe(true);

		const ready = await waitForRunReady(proc.client, sessionId, created.runId);
		expect(ready.state).toBe("ready");
		expect(ready.tester).toBe("std");

		const first = await judgePoint(proc.client, sessionId, created.runId, String(detail.data[0]?.id));
		expect(first.status).toBe("AC");
		expect(first.score).toBe(1);
		expect(first.fullScore).toBe(33);
		expect(first.message).toBe("AC");
		expect(events.some((e) => e.method === "run/output" && e.channel === "judge")).toBe(true);

		await judgePoint(proc.client, sessionId, created.runId, String(detail.data[1]?.id));
		await judgePoint(proc.client, sessionId, created.runId, String(detail.data[2]?.id));

		const score = await proc.client.call("run/score", { sessionId, runId: created.runId });
		expect(score.judged).toBe(3);
		expect(score.total).toBe(3);
		expect(score.report.total).toBe(100);
		expect(score.report.fullScore).toBe(100);

		const snapshot = await proc.client.call("run/get", { sessionId, runId: created.runId });
		expect(snapshot.judged).toHaveLength(3);
		expect(snapshot.report?.total).toBe(100);

		// ⚠️ 数字 testId 被服务端拒绝：`problem/get` 给 number，`run/judge` 只收 string。
		await expect(
			proc.client.call("run/judge", { sessionId, runId: created.runId, testId: 2 as unknown as string }),
		).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
	});

	it("run/judge：RE/TLE 的 message 为 null、TLE 的 timeMs 为 null（protocol.ts 声明 message: string）", async () => {
		const reRun = await createRun(proc.client, sessionId, "re.cpp");
		const re = await judgePoint(proc.client, sessionId, reRun, "1");
		expect(re.status).toBe("RE");
		const reMessage: unknown = re.message;
		expect(reMessage, "RE 时 message 实测为 null，protocol.ts 声明 string").toBeNull();

		const tleRun = await createRun(proc.client, sessionId, "tle.cpp");
		const tle = await judgePoint(proc.client, sessionId, tleRun, "1");
		expect(tle.status).toBe("TLE");
		expect(tle.timeMs).toBeNull();
		expect(tle.message).toBeNull();
	});

	it("workspace/close：取消 ready 的 run（事件 run/finished: cancelled）；随后 run/get 是 -32001 而非 -32006", async () => {
		const opened = await proc.client.call("workspace/open", { uri: workspaceUri });
		const runId = await createRun(proc.client, opened.sessionId);
		await proc.client.call("workspace/close", { sessionId: opened.sessionId });
		await delay(200);

		const finished = events.find(
			(e): e is Extract<RpcEvent, { method: "run/finished" }> => e.method === "run/finished" && e.runId === runId,
		);
		expect(finished?.state).toBe("cancelled");

		// ⚠️ 会话先被销毁，所以拿到的是 -32001（SessionNotFound），文档里写的是 -32006。
		await expect(proc.client.call("run/get", { sessionId: opened.sessionId, runId })).rejects.toMatchObject({
			code: ErrorCode.SessionNotFound,
		});
	});

	it("config/set：snake_case 的 file_io 静默丢弃（revision 仍 +1），kebab 的 file-io 才生效", async () => {
		const before = await proc.client.call("config/get", { sessionId, scope: DAY });

		// 1) protocol.ts / config/schema 用的 snake_case 写法：返回成功、revision +1，但字段不见了。
		const snake = await proc.client.call("config/set", {
			sessionId,
			scope: DAY,
			field: "/file_io",
			value: false,
			revision: before.revision,
		});
		expect(snake.revision).toBe(before.revision + 1);
		expect(snake.config["file_io"]).toBeUndefined();
		expect((await proc.client.call("problem/get", { sessionId, problem: PROBLEM_SCOPE })).problem.fileIo).toBeNull();

		// 2) 真实 FileView 键是 kebab-case：file-io。
		const kebab = await proc.client.call("config/set", { sessionId, scope: DAY, field: "/file-io", value: false });
		expect(kebab.config["file-io"]).toBe(false);
		expect((await proc.client.call("problem/get", { sessionId, problem: PROBLEM_SCOPE })).problem.fileIo).toBe(false);
		const onDisk = JSON.parse(fs.readFileSync(path.join(contestRoot, DAY, "conf.json"), "utf8")) as Record<string, unknown>;
		expect(onDisk["file-io"]).toBe(false);
		expect(onDisk["file_io"]).toBeUndefined();

		// 3) 生效后 stdio 题解 AC，file-io 题解反而 RE。
		const stdioRun = await createRun(proc.client, sessionId, "stdio.cpp");
		expect((await judgePoint(proc.client, sessionId, stdioRun, "1")).status).toBe("AC");
		const fileIoRun = await createRun(proc.client, sessionId, "std");
		expect((await judgePoint(proc.client, sessionId, fileIoRun, "1")).status).toBe("RE");

		// 3.5) 题目层写不进这三个开关（ProblemConfig 里是 file(skip)）：返回成功、字段消失、继承值不变。
		const atProblem = await proc.client.call("config/set", { sessionId, scope: PROBLEM_SCOPE, field: "/file-io", value: true });
		expect(atProblem.config["file-io"]).toBeUndefined();
		expect((await proc.client.call("problem/get", { sessionId, problem: PROBLEM_SCOPE })).problem.fileIo).toBe(false);

		// 4) 未知字段同样被静默丢弃（不报错、revision 仍 +1）。
		const bogus = await proc.client.call("config/set", { sessionId, scope: DAY, field: "/nope", value: 1 });
		expect(bogus.config["nope"]).toBeUndefined();

		// 5) revision 是 session-global 乐观并发：过期值 → -32007。
		await expect(
			proc.client.call("config/set", { sessionId, scope: DAY, field: "/title", value: "x", revision: before.revision }),
		).rejects.toMatchObject({ code: ErrorCode.RevisionConflict });

		// 还原（`file-io: true` 与「未设置」在 judge 上等价）。
		const restored = await proc.client.call("config/set", { sessionId, scope: DAY, field: "/file-io", value: true });
		expect(restored.config["file-io"]).toBe(true);
	});

	it("错误码：-32600 生命周期 / -32601 未知方法 / -32001 会话 / -32002 非工程 / -32005 模板", async () => {
		const raw = connectRaw(childEnv);
		try {
			const { client } = raw;
			await expect(client.rawCall("workspace/list")).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });

			await client.rawCall("initialize", { clientInfo: { name: CLIENT_INFO.clientName, version: CLIENT_INFO.clientVersion } });
			await expect(
				client.rawCall("initialize", { clientInfo: { name: CLIENT_INFO.clientName, version: CLIENT_INFO.clientVersion } }),
			).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });

			await expect(client.rawCall("nope/nope", {})).rejects.toMatchObject({ code: ErrorCode.MethodNotFound });
			await expect(client.rawCall("config/get", { sessionId: "s-999", scope: "contest" })).rejects.toMatchObject({
				code: ErrorCode.SessionNotFound,
			});

			// 非工程目录：open 成功但 contest=null；此后 config 类方法 -32002。
			const plain = await client.rawCall("workspace/open", { uri: `file://${workRoot}` });
			const openedPlain = plain as { sessionId: string; contest: unknown };
			expect(openedPlain.contest).toBeNull();
			await expect(client.rawCall("config/get", { sessionId: openedPlain.sessionId, scope: "contest" })).rejects.toMatchObject({
				code: ErrorCode.InvalidWorkspace,
			});

			const opened = (await client.rawCall("workspace/open", { uri: `file://${contestRoot}` })) as { sessionId: string };
			// ren/preview 的 scope 必须精确到题目；ren/run 的模板必须存在。
			await expect(client.rawCall("ren/preview", { sessionId: opened.sessionId, scope: DAY })).rejects.toMatchObject({
				code: ErrorCode.InvalidParams,
			});
			await expect(
				client.rawCall("ren/run", { sessionId: opened.sessionId, template: "no-such-template" }),
			).rejects.toMatchObject({ code: ErrorCode.InvalidConfigField });
		} finally {
			await raw.dispose();
		}
	});
});

describe.skipIf(!enabled)("tuack-ng-rpc 两进程（RpcPool）", () => {
	let workRoot = "";
	let contestRoot = "";
	let childEnv: NodeJS.ProcessEnv = process.env;
	let probedAssetsDirs: readonly string[] | undefined;

	beforeAll(async () => {
		const prepared = await prepareWorkRoot("tuack-vscode-smoke-pool-");
		workRoot = prepared.workRoot;
		contestRoot = prepared.contestRoot;
		childEnv = prepared.env;
		probedAssetsDirs = prepared.assets;
	});

	afterAll(() => {
		if (workRoot) {
			fs.rmSync(workRoot, { recursive: true, force: true });
		}
	});

	it("P2 跑 run/* 的同时 P1 仍能响应 ren/preview；id 带命名空间、早到事件被回放", async () => {
		const pool = new RpcPool({
			workspaceUri: `file://${contestRoot}`,
			p2IdleTimeoutMs: 0,
			createEndpoint: createProcessEndpointFactory({
				command: RPC_BIN as string,
				env: childEnv,
				probedAssetsDirs,
				...CLIENT_INFO,
				initializeTimeoutMs: 30_000,
			}),
		});
		const seen: { method: string; role: string; namespace: string; runId?: string }[] = [];
		pool.onEvent((event, meta) => {
			seen.push({
				method: event.method,
				role: meta.role,
				namespace: meta.namespace,
				...(event.method.startsWith("run/") ? { runId: (event as Extract<RpcEvent, { runId: string }>).runId } : {}),
			});
		});

		try {
			const preview = await pool.call("ren/preview", { sessionId: "placeholder", scope: PROBLEM_SCOPE });
			expect(preview.markdown).toContain("## 题目描述");
			expect(pool.controlEndpoint?.namespace).toBe("p1");
			expect(pool.evaluationEndpoint).toBeUndefined();

			const created = await pool.call("run/create", { sessionId: "placeholder", problem: PROBLEM_SCOPE, target: "data" });
			expect(created.runId.startsWith("p2:1:")).toBe(true);
			expect(pool.evaluationEndpoint?.namespace).toBe("p2:1");

			// 早到事件（run/started 先于 run/create 响应）应已按命名空间回放。
			expect(seen.some((e) => e.method === "run/started" && e.runId === created.runId && e.role === "p2")).toBe(true);

			const deadline = Date.now() + 60_000;
			let state = "preparing";
			while (Date.now() < deadline) {
				const snapshot = await pool.call("run/get", { sessionId: "placeholder", runId: created.runId });
				state = snapshot.state;
				if (state !== "preparing") {
					break;
				}
				await delay(100);
			}
			expect(state).toBe("ready");

			// P2 上跑 judge 的同时，P1 上的同步 handler（ren/preview）仍然可用。
			const [judged, previewed] = await Promise.all([
				pool.call("run/judge", { sessionId: "placeholder", runId: created.runId, testId: "1" }, { timeoutMs: 120_000 }),
				pool.call("ren/preview", { sessionId: "placeholder", scope: PROBLEM_SCOPE }),
			]);
			expect(judged.status).toBe("AC");
			expect(previewed.markdown).toContain("## 题目描述");

			const score = await pool.call("run/score", { sessionId: "placeholder", runId: created.runId });
			expect(score.judged).toBe(1);
		} finally {
			await pool.dispose();
		}
	});
});
