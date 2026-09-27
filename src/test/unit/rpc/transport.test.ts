/**
 * NDJSON 分帧测试：跨 chunk 的行与多字节字符、空行/CRLF/BOM、
 * 非法 JSON 可恢复、超长行丢弃后重新同步。
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../core/log", () => ({
	logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
}));

import { NdjsonParseError, NdjsonTransport, splitLines } from "../../../rpc/transport";

function feed(...chunks: (Buffer | string)[]): { lines: string[]; rest: Buffer } {
	let pending: Buffer = Buffer.alloc(0);
	const lines: string[] = [];
	for (const chunk of chunks) {
		const result = splitLines(pending, chunk);
		lines.push(...result.lines);
		pending = result.rest;
	}
	return { lines, rest: pending };
}

describe("splitLines（纯分帧）", () => {
	it("单行完整数据", () => {
		const { lines, rest } = feed('{"a":1}\n');
		expect(lines).toEqual(['{"a":1}']);
		expect(rest.length).toBe(0);
	});

	it("没有换行时全部留在 rest", () => {
		const { lines, rest } = feed('{"a":');
		expect(lines).toEqual([]);
		expect(rest.toString("utf8")).toBe('{"a":');
	});

	it("一行被切成多个 chunk（跨 chunk 拼接）", () => {
		const { lines, rest } = feed('{"a":', "1,", '"b":2}', "\n");
		expect(lines).toEqual(['{"a":1,"b":2}']);
		expect(rest.length).toBe(0);
	});

	it("一个 chunk 里有多个完整行", () => {
		const { lines } = feed('{"a":1}\n{"b":2}\n{"c":3}\n');
		expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
	});

	it("多个 chunk 里各有多行，且最后一行不完整", () => {
		const { lines, rest } = feed('{"a":1}\n{"b":2}\n', '{"c":', '3}\n{"d":4}');
		expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
		expect(rest.toString("utf8")).toBe('{"d":4}');
	});

	it("空行会作为空字符串切出来（由上层决定忽略）", () => {
		const { lines } = feed("\n\n{\"a\":1}\n\n");
		expect(lines).toEqual(["", "", '{"a":1}', ""]);
	});

	it("CRLF 会去掉 \\r", () => {
		const { lines } = feed('{"a":1}\r\n');
		expect(lines).toEqual(['{"a":1}']);
	});

	it("多字节 UTF-8 跨 chunk 不会被切坏", () => {
		// "中" = E4 B8 AD，"文" = E6 96 87；在字符中间切断。
		const text = '{"s":"中文"}\n';
		const bytes = Buffer.from(text, "utf8");
		const cut = 6; // 落在 "中" 的字节中间
		const { lines, rest } = feed(bytes.subarray(0, cut), bytes.subarray(cut));
		expect(lines).toEqual(['{"s":"中文"}']);
		expect(rest.length).toBe(0);
	});

	it("逐字节喂入也能正确还原", () => {
		const bytes = Buffer.from('{"s":"中文🙂"}\n', "utf8");
		const chunks = [...bytes].map((b) => Buffer.from([b]));
		const { lines } = feed(...chunks);
		expect(lines).toEqual(['{"s":"中文🙂"}']);
	});

	it("BOM 会被剥掉（否则 JSON.parse 必失败）", () => {
		const { lines } = feed(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\n')]));
		expect(lines).toEqual(['{"a":1}']);
	});
});

interface Harness {
	transport: NdjsonTransport;
	input: PassThrough;
	output: PassThrough;
	messages: Record<string, unknown>[];
	parseErrors: NdjsonParseError[];
	ends: string[];
	written: string[];
}

function harness(options?: { maxLineBytes?: number }): Harness {
	const input = new PassThrough();
	const output = new PassThrough();
	const messages: Record<string, unknown>[] = [];
	const parseErrors: NdjsonParseError[] = [];
	const ends: string[] = [];
	const written: string[] = [];
	output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
	const transport = new NdjsonTransport({
		input,
		output,
		onMessage: (message) => messages.push(message),
		onParseError: (error) => parseErrors.push(error),
		onEnd: (reason) => ends.push(reason),
		maxLineBytes: options?.maxLineBytes,
	});
	return { transport, input, output, messages, parseErrors, ends, written };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("NdjsonTransport", () => {
	it("按行投递消息，跳过空行", async () => {
		const h = harness();
		h.input.write('{"jsonrpc":"2.0","id":1,"result":null}\n\n{"jsonrpc":"2.0","method":"run/started"}\n');
		await tick();
		expect(h.messages).toHaveLength(2);
		expect(h.transport.messagesReceived).toBe(2);
		expect(h.transport.bytesReceived).toBeGreaterThan(0);
	});

	it("非法 JSON 走 onParseError 且不打断后续消息（可恢复）", async () => {
		const h = harness();
		h.input.write("这不是 JSON\n");
		h.input.write('{"jsonrpc":"2.0","id":1,"result":null}\n');
		await tick();
		expect(h.parseErrors).toHaveLength(1);
		expect(h.parseErrors[0]?.kind).toBe("json");
		expect(h.messages).toHaveLength(1);
		expect(h.transport.parseErrors).toBe(1);
	});

	it("顶层不是对象（数组/数字/字符串）判为 shape 错误", async () => {
		const h = harness();
		h.input.write("[1,2,3]\n");
		h.input.write("42\n");
		h.input.write('"str"\n');
		await tick();
		expect(h.parseErrors.map((e) => e.kind)).toEqual(["shape", "shape", "shape"]);
		expect(h.messages).toHaveLength(0);
	});

	it("超长行会被丢弃并重新同步到下一个换行", async () => {
		const h = harness({ maxLineBytes: 16 });
		h.input.write("x".repeat(64));
		await tick();
		expect(h.parseErrors).toHaveLength(1);
		expect(h.parseErrors[0]?.kind).toBe("overflow");
		// 后续数据仍然能解析
		h.input.write("\n");
		h.input.write('{"jsonrpc":"2.0","id":7,"result":null}\n');
		await tick();
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0]?.["id"]).toBe(7);
	});

	it("写入会自动补换行且是 NDJSON", () => {
		const h = harness();
		h.transport.writeValue({ jsonrpc: "2.0", id: 1, method: "shutdown" });
		expect(h.written.join("")).toBe('{"jsonrpc":"2.0","id":1,"method":"shutdown"}\n');
	});

	it("input 结束时把最后一段不完整数据也解析一次，并回调 onEnd", async () => {
		const h = harness();
		h.input.write('{"jsonrpc":"2.0","id":9,"result":null}');
		h.input.end();
		await tick();
		expect(h.messages).toHaveLength(1);
		expect(h.ends).toContain("input-end");
		expect(h.transport.isClosed).toBe(true);
	});

	it("close() 后不再投递消息", async () => {
		const h = harness();
		h.transport.close();
		h.input.write('{"jsonrpc":"2.0","id":1,"result":null}\n');
		await tick();
		expect(h.messages).toHaveLength(0);
		expect(h.ends).toHaveLength(0);
	});

	it("close() 后写入会抛 TransportClosed", () => {
		const h = harness();
		h.transport.close();
		expect(() => h.transport.writeValue({})).toThrowError(/传输已关闭/);
	});
});
