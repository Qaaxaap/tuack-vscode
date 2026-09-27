/**
 * 事件路由测试：早到事件缓冲/回放、seq 缺口检测、事件总线、能力映射。
 *
 * 「`run/started` 先于 `runId` 响应」是协议事实，这里锁住回放行为。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import type { RpcEvent } from "../../../rpc/protocol";
import {
	EventCorrelator,
	RpcEventBus,
	SeqTracker,
	capabilityForMethod,
	classifyNotification,
	isRenEvent,
	isRunEvent,
	streamIdFromResult,
	streamIdOfEvent,
	streamKindOfMethod,
} from "../../../rpc/events";

function runStarted(runId: string, seq = 1): RpcEvent {
	return { seq, sessionId: "s-1", method: "run/started", runId, problem: "day1/p1", target: "data", tester: "std" };
}

function runOutput(runId: string, seq = 2): RpcEvent {
	return { seq, sessionId: "s-1", method: "run/output", runId, testId: null, channel: "compiler", text: "…" };
}

function renProgress(taskId: string, seq = 1): RpcEvent {
	return { seq, sessionId: "s-1", method: "ren/progress", taskId, done: 1, total: 2, item: "day1" };
}

describe("事件辅助函数", () => {
	it("区分 run/ren 流", () => {
		expect(streamKindOfMethod("run/output")).toBe("run");
		expect(streamKindOfMethod("ren/output")).toBe("ren");
		expect(streamKindOfMethod("initialize")).toBeUndefined();
		expect(isRunEvent(runStarted("r-1"))).toBe(true);
		expect(isRenEvent(runStarted("r-1"))).toBe(false);
		expect(streamIdOfEvent(runStarted("r-1"))).toBe("r-1");
		expect(streamIdOfEvent(renProgress("t-1"))).toBe("t-1");
	});

	it("从创建型方法的响应里取新 id", () => {
		expect(streamIdFromResult("run/create", { runId: "r-1" })).toEqual({ kind: "run", id: "r-1" });
		expect(streamIdFromResult("ren/run", { taskId: "t-9" })).toEqual({ kind: "ren", id: "t-9" });
		expect(streamIdFromResult("run/create", {})).toBeNull();
		expect(streamIdFromResult("config/get", { runId: "r-1" })).toBeNull();
		expect(streamIdFromResult("run/create", null)).toBeNull();
	});

	it("方法 → capability 映射", () => {
		expect(capabilityForMethod("workspace/open")).toBe("workspace");
		expect(capabilityForMethod("config/set")).toBe("config");
		expect(capabilityForMethod("problem/list")).toBe("problem");
		expect(capabilityForMethod("run/judge")).toBe("run");
		expect(capabilityForMethod("ren/preview")).toBe("ren");
		expect(capabilityForMethod("initialize")).toBeUndefined();
		expect(capabilityForMethod("shutdown")).toBeUndefined();
		expect(capabilityForMethod("exit")).toBeUndefined();
		expect(capabilityForMethod("future/thing")).toBeUndefined();
	});

	it("未知通知只归类为 unknown（调用方只记日志）", () => {
		expect(classifyNotification({ jsonrpc: "2.0", method: "ren/pushed" })).toEqual({ kind: "unknown", method: "ren/pushed" });
		const classified = classifyNotification({ jsonrpc: "2.0", method: "run/started" });
		expect(classified.kind).toBe("event");
	});
});

describe("SeqTracker", () => {
	it("从 1 开始；连续递增不算缺口", () => {
		const tracker = new SeqTracker();
		expect(tracker.observe(1)).toEqual({ first: true, gap: false, missed: 0 });
		expect(tracker.observe(2)).toEqual({ first: false, gap: false, missed: 0 });
		expect(tracker.observe(3).gap).toBe(false);
		expect(tracker.gaps).toBe(0);
		expect(tracker.lastSeq).toBe(3);
	});

	it("检测缺口并统计跳过条数", () => {
		const tracker = new SeqTracker();
		tracker.observe(1);
		const result = tracker.observe(5);
		expect(result).toEqual({ first: false, gap: true, missed: 3 });
		expect(tracker.gaps).toBe(1);
	});

	it("乱序/重复的旧 seq 不会把 lastSeq 拉回去", () => {
		const tracker = new SeqTracker();
		tracker.observe(5);
		expect(tracker.observe(3).gap).toBe(false);
		expect(tracker.lastSeq).toBe(5);
	});

	it("reset 清空", () => {
		const tracker = new SeqTracker();
		tracker.observe(4);
		tracker.reset();
		expect(tracker.lastSeq).toBe(0);
		expect(tracker.gaps).toBe(0);
	});
});

describe("RpcEventBus", () => {
	it("全部事件订阅 + 按方法订阅都会收到；dispose 生效", () => {
		const bus = new RpcEventBus();
		const all: string[] = [];
		const onlyStarted: string[] = [];
		const allSub = bus.on((event) => all.push(event.method));
		const methodSub = bus.onMethod("run/started", (event) => onlyStarted.push(event.runId));
		bus.emit(runStarted("r-1"));
		bus.emit(runOutput("r-1"));
		expect(all).toEqual(["run/started", "run/output"]);
		expect(onlyStarted).toEqual(["r-1"]);
		allSub.dispose();
		methodSub.dispose();
		bus.emit(runStarted("r-2"));
		expect(all).toHaveLength(2);
		expect(bus.listenerCount).toBe(0);
	});

	it("单个订阅者抛错不影响其它订阅者", () => {
		const bus = new RpcEventBus();
		const seen: string[] = [];
		bus.on(() => {
			throw new Error("bad handler");
		});
		bus.on((event) => seen.push(event.method));
		expect(() => bus.emit(runStarted("r-1"))).not.toThrow();
		expect(seen).toEqual(["run/started"]);
	});
});

describe("EventCorrelator（早到事件）", () => {
	it("未识别的 id 先缓冲，recognize 后按到达顺序回放", () => {
		const correlator = new EventCorrelator();
		expect(correlator.route(runStarted("r-1"))).toBe(false);
		expect(correlator.route(runOutput("r-1", 2))).toBe(false);
		expect(correlator.route(runStarted("r-2"))).toBe(false);
		expect(correlator.bufferedCount).toBe(3);

		const replay = correlator.recognize("run", "r-1");
		expect(replay.map((e) => e.method)).toEqual(["run/started", "run/output"]);
		expect(correlator.bufferedCount).toBe(1);

		// 已登记的 id 直接放行
		expect(correlator.route(runOutput("r-1", 3))).toBe(true);
		// 另一个 id 仍未登记
		expect(correlator.route(runStarted("r-3"))).toBe(false);
	});

	it("run 与 ren 的 id 空间互不干扰", () => {
		const correlator = new EventCorrelator();
		correlator.route(runStarted("1"));
		correlator.route(renProgress("1"));
		expect(correlator.bufferedCount).toBe(2);
		expect(correlator.recognize("run", "1")).toHaveLength(1);
		expect(correlator.bufferedCount).toBe(1);
		expect(correlator.recognize("ren", "1")).toHaveLength(1);
	});

	it("缓冲上限：溢出时丢最旧的并回调 onDrop", () => {
		const dropped: string[] = [];
		const correlator = new EventCorrelator({ maxBufferedEvents: 2, onDrop: (event) => dropped.push(event.method) });
		correlator.route(runStarted("r-1", 1));
		correlator.route(runStarted("r-2", 2));
		correlator.route(runStarted("r-3", 3));
		expect(correlator.bufferedCount).toBe(2);
		expect(dropped).toEqual(["run/started"]);
		// 最旧的（r-1）已经被丢掉，回放不出来
		expect(correlator.recognize("run", "r-1")).toHaveLength(0);
	});

	it("discardWhere / flush / forgetNamespace", () => {
		const correlator = new EventCorrelator();
		correlator.route(runStarted("p2:1:r-1"));
		correlator.route(runStarted("p1:r-2"));
		expect(correlator.discardWhere((event) => streamIdOfEvent(event)?.startsWith("p2:1:") === true)).toBe(1);
		expect(correlator.bufferedCount).toBe(1);
		expect(correlator.flush()).toHaveLength(1);
		expect(correlator.bufferedCount).toBe(0);

		correlator.recognize("run", "p2:1:r-9");
		correlator.recognize("run", "p1:r-9");
		correlator.recognize("ren", "p2:1:t-9");
		expect(correlator.forgetNamespace("p2:1")).toBe(2);
		expect(correlator.isKnown("run", "p1:r-9")).toBe(true);
		expect(correlator.isKnown("run", "p2:1:r-9")).toBe(false);
		expect(correlator.isKnown("ren", "p2:1:t-9")).toBe(false);
	});

	it("forget 后同 id 事件会重新进入缓冲", () => {
		const correlator = new EventCorrelator();
		correlator.recognize("run", "r-1");
		expect(correlator.route(runStarted("r-1"))).toBe(true);
		correlator.forget("run", "r-1");
		expect(correlator.route(runStarted("r-1"))).toBe(false);
	});

	it("无 id 字段的事件不会被缓冲（防止泄漏）", () => {
		const correlator = new EventCorrelator();
		const weird = { seq: 1, sessionId: "s", method: "run/finished" } as unknown as RpcEvent;
		expect(correlator.route(weird)).toBe(true);
		expect(correlator.bufferedCount).toBe(0);
	});
});
