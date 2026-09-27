/**
 * 错误类型与错误码映射测试。错误码是 UI 分支的依据，不能丢也不能改。
 */

import { describe, expect, it } from "vitest";

import { ErrorCode } from "../../../rpc/protocol";
import {
	ERROR_CODE_NAMES,
	LocalErrorCode,
	TuackRpcError,
	asRpcError,
	describeErrorCode,
	errorCodeName,
	isRpcError,
	methodNotFoundError,
} from "../../../rpc/errors";

describe("TuackRpcError", () => {
	it("保留 code / message / data", () => {
		const error = new TuackRpcError(-32006, "run 不存在", { runId: "r-1" });
		expect(error.code).toBe(-32006);
		expect(error.message).toBe("run 不存在");
		expect(error.data).toEqual({ runId: "r-1" });
		expect(error.name).toBe("TuackRpcError");
		expect(error).toBeInstanceOf(Error);
	});

	it("fromFailure 把服务端 error 映射成带 code 的异常", () => {
		const error = TuackRpcError.fromFailure({
			jsonrpc: "2.0",
			id: 3,
			error: { code: ErrorCode.RevisionConflict, message: "revision 过期", data: { expected: 4 } },
		});
		expect(error.code).toBe(ErrorCode.RevisionConflict);
		expect(error.message).toContain("RevisionConflict");
		expect(error.message).toContain("revision 过期");
		expect(error.data).toEqual({ expected: 4 });
		expect(error.isLocal).toBe(false);
	});

	it("fromFailure 在服务端 message 为空时用错误码说明兜底", () => {
		const error = TuackRpcError.fromFailure({
			jsonrpc: "2.0",
			id: 1,
			error: { code: ErrorCode.InvalidConfigField, message: "" },
		});
		expect(error.message).toContain("InvalidConfigField");
		expect(error.message).toContain("time limit");
	});

	it("local 构造的错误 isLocal 为 true，且能识别超时/进程消失", () => {
		const timeout = TuackRpcError.local(LocalErrorCode.Timeout, "超时", { method: "run/judge" });
		expect(timeout.isLocal).toBe(true);
		expect(timeout.isTimeout).toBe(true);
		expect(timeout.isProcessGone).toBe(false);

		const gone = TuackRpcError.local(LocalErrorCode.ProcessExited, "进程已退出");
		expect(gone.isProcessGone).toBe(true);
		expect(gone.isTimeout).toBe(false);
	});

	it("methodNotFound 判定走服务端 -32601", () => {
		expect(methodNotFoundError("ren/templates").isMethodNotFound).toBe(true);
		expect(TuackRpcError.local(LocalErrorCode.Timeout, "x").isMethodNotFound).toBe(false);
	});

	it("fromUnknown 保留 cause 与 message", () => {
		const cause = new Error("ENOENT");
		const error = TuackRpcError.fromUnknown(LocalErrorCode.SpawnFailed, "无法启动", cause);
		expect(error.code).toBe(LocalErrorCode.SpawnFailed);
		expect(error.message).toContain("ENOENT");
		expect(error.dataAs<{ causeMessage: string }>()?.causeMessage).toBe("ENOENT");
	});

	it("dataAs 能给调用方做类型化读取", () => {
		const error = new TuackRpcError(ErrorCode.RunFailed, "x", { exitCode: 1 });
		expect(error.dataAs<{ exitCode: number }>()?.exitCode).toBe(1);
	});
});

describe("isRpcError", () => {
	it("识别 TuackRpcError，拒绝普通 Error/字符串", () => {
		expect(isRpcError(new TuackRpcError(1, "x"))).toBe(true);
		expect(isRpcError(new Error("x"))).toBe(false);
		expect(isRpcError("x")).toBe(false);
		expect(isRpcError(null)).toBe(false);
	});

	it("支持按单个码或码集合精确匹配", () => {
		const error = new TuackRpcError(ErrorCode.SessionNotFound, "会话不存在");
		expect(isRpcError(error, ErrorCode.SessionNotFound)).toBe(true);
		expect(isRpcError(error, ErrorCode.RunNotFound)).toBe(false);
		expect(isRpcError(error, [ErrorCode.SessionNotFound, ErrorCode.RunNotFound])).toBe(true);
		expect(isRpcError(error, [ErrorCode.RunNotFound])).toBe(false);
	});
});

describe("错误码表", () => {
	it("每个服务端错误码都有名字与说明", () => {
		for (const code of Object.values(ErrorCode)) {
			expect(ERROR_CODE_NAMES[code]).toBeTruthy();
			expect(describeErrorCode(code)).not.toContain("未知错误码");
		}
	});

	it("本地错误码位于 -32090 以下，且与服务端码段不冲突", () => {
		const serverCodes = new Set<number>(Object.values(ErrorCode));
		const localCodes = Object.values(LocalErrorCode);
		expect(new Set(localCodes).size).toBe(localCodes.length);
		for (const code of localCodes) {
			expect(code).toBeLessThanOrEqual(-32090);
			expect(serverCodes.has(code)).toBe(false);
			expect(ERROR_CODE_NAMES[code]).toBeTruthy();
		}
	});

	it("未知错误码原样带出", () => {
		expect(errorCodeName(-99999)).toBe("Unknown(-99999)");
		expect(describeErrorCode(-99999)).toContain("-99999");
	});

	it("asRpcError 归一化任意异常", () => {
		const existing = new TuackRpcError(ErrorCode.InternalError, "x");
		expect(asRpcError(existing)).toBe(existing);
		const wrapped = asRpcError(new Error("boom"), LocalErrorCode.SpawnFailed);
		expect(wrapped.code).toBe(LocalErrorCode.SpawnFailed);
		expect(wrapped.message).toContain("boom");
	});
});
