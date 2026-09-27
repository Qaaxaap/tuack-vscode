/**
 * 协议契约测试：scope 转义、信封判定、方法/事件清单。
 * 对应上游 PROTOCOL.md §4/§5；转义错了 `config/get` 会报 -32005。
 */

import { describe, expect, it } from "vitest";

import {
	ErrorCode,
	KNOWN_EVENT_METHODS,
	KNOWN_METHODS,
	PROTOCOL_VERSION,
	escapeScopeSegment,
	isKnownEvent,
	isNotification,
	isResponse,
	makeProblemId,
	makeScope,
	parseScope,
	unescapeScopeSegment,
} from "../../../rpc/protocol";

describe("protocol 基本常量", () => {
	it("协议版本是 0.1", () => {
		expect(PROTOCOL_VERSION).toBe("0.1");
	});

	it("方法表恰好 21 个且无重复", () => {
		expect(KNOWN_METHODS).toHaveLength(21);
		expect(new Set(KNOWN_METHODS).size).toBe(21);
	});

	it("事件清单恰好 8 个且无重复", () => {
		expect(KNOWN_EVENT_METHODS).toHaveLength(8);
		expect(new Set(KNOWN_EVENT_METHODS).size).toBe(8);
	});

	it("错误码与协议 §5 一致", () => {
		expect(ErrorCode.ParseError).toBe(-32700);
		expect(ErrorCode.InvalidRequest).toBe(-32600);
		expect(ErrorCode.MethodNotFound).toBe(-32601);
		expect(ErrorCode.InvalidParams).toBe(-32602);
		expect(ErrorCode.InternalError).toBe(-32000);
		expect(ErrorCode.SessionNotFound).toBe(-32001);
		expect(ErrorCode.InvalidWorkspace).toBe(-32002);
		expect(ErrorCode.CompileFailed).toBe(-32003);
		expect(ErrorCode.RunFailed).toBe(-32004);
		expect(ErrorCode.InvalidConfigField).toBe(-32005);
		expect(ErrorCode.RunNotFound).toBe(-32006);
		expect(ErrorCode.RevisionConflict).toBe(-32007);
	});
});

describe("scope 转义（JSON Pointer 规则）", () => {
	it("先转义 ~ 再转义 /", () => {
		expect(escapeScopeSegment("a/b")).toBe("a~1b");
		expect(escapeScopeSegment("a~b")).toBe("a~0b");
		// 必须先 ~ 后 /，否则 "~/" 会被转两次
		expect(escapeScopeSegment("~/")).toBe("~0~1");
		expect(escapeScopeSegment("~1")).toBe("~01");
	});

	it("unescape 是 escape 的逆运算", () => {
		for (const raw of ["day1", "a/b", "a~b", "~/", "~1", "普通中文/带 空格", "a~0~1b"]) {
			expect(unescapeScopeSegment(escapeScopeSegment(raw))).toBe(raw);
		}
	});

	it("unescape 顺序相反：先 ~1 再 ~0", () => {
		expect(unescapeScopeSegment("~0~1")).toBe("~/");
		expect(unescapeScopeSegment("~01")).toBe("~1");
	});

	it("makeScope：无 day 时为 contest", () => {
		expect(makeScope()).toBe("contest");
		expect(makeScope(undefined, "p1")).toBe("contest");
		expect(makeScope("", "p1")).toBe("contest");
	});

	it("makeScope：day / day+problem 会转义", () => {
		expect(makeScope("day1")).toBe("day1");
		expect(makeScope("day1", "p1")).toBe("day1/p1");
		expect(makeScope("d/1", "p~2")).toBe("d~11/p~02");
	});

	it("parseScope：contest 与空串都是空对象", () => {
		expect(parseScope("contest")).toEqual({});
		expect(parseScope("")).toEqual({});
	});

	it("parseScope 还原 day/problem", () => {
		expect(parseScope("day1")).toEqual({ day: "day1", problem: undefined });
		expect(parseScope("day1/p1")).toEqual({ day: "day1", problem: "p1" });
		expect(parseScope("d~11/p~02")).toEqual({ day: "d/1", problem: "p~2" });
	});

	it("makeScope/parseScope 往返一致（含需转义的 key）", () => {
		const cases: [string, string][] = [
			["day1", "p1"],
			["d/1", "p~2"],
			["~", "/"],
		];
		for (const [day, problem] of cases) {
			expect(parseScope(makeScope(day, problem))).toEqual({ day, problem });
		}
	});

	it("makeProblemId 用同样的转义规则", () => {
		expect(makeProblemId("day1", "p1")).toBe("day1/p1");
		expect(makeProblemId("d/1", "p~2")).toBe("d~11/p~02");
	});
});

describe("信封判定", () => {
	it("isResponse 认 result 与 error 两种", () => {
		expect(isResponse({ jsonrpc: "2.0", id: 1, result: null })).toBe(true);
		expect(isResponse({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "x" } })).toBe(true);
		expect(isResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "x" } })).toBe(true);
		expect(isResponse({ jsonrpc: "2.0", method: "run/started" })).toBe(false);
		expect(isResponse(null)).toBe(false);
		expect(isResponse("x")).toBe(false);
	});

	it("isNotification 要求有 method 且无 id/result/error", () => {
		expect(isNotification({ jsonrpc: "2.0", method: "run/started", params: {} })).toBe(true);
		expect(isNotification({ jsonrpc: "2.0", method: "run/started", id: 1 })).toBe(false);
		expect(isNotification({ jsonrpc: "2.0", method: "run/started", result: {} })).toBe(false);
		expect(isNotification({ jsonrpc: "2.0", id: 1, result: {} })).toBe(false);
	});

	it("isKnownEvent 覆盖全部已知事件、拒绝未知事件", () => {
		for (const method of KNOWN_EVENT_METHODS) {
			expect(isKnownEvent(method)).toBe(true);
		}
		expect(isKnownEvent("run/whatever")).toBe(false);
		expect(isKnownEvent("ren/incremental-preview")).toBe(false);
	});
});
