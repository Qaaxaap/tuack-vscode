import { describe, expect, it } from "vitest";

import {
	HOST_SCROLL_LOCK_MS,
	MIN_SCROLL_TARGET,
	SCROLL_LOCK_DELAYS_MS,
	SCROLL_THROTTLE_MS,
	SNAP_ZONE_RATIO,
	createScrollLock,
	createThrottle,
	findBoundsForLine,
	findLinePair,
	isWithinSnapZone,
	lineForPageOffset,
	pageOffsetForLine,
	type LineBounds,
} from "../../../webview/scrollSync";

/** 造一个锚点块；普通块 `endLine === line`，代码块传更大的 endLine。 */
function block(
	line: number,
	top: number,
	height: number,
	options: { endLine?: number; contentTop?: number; contentHeight?: number } = {},
): LineBounds {
	return {
		line,
		endLine: options.endLine ?? line,
		top,
		height,
		contentTop: options.contentTop ?? top,
		contentHeight: options.contentHeight ?? height,
	};
}

/** 假 timer：`advance` 会按时间顺序触发到期的回调（可测锁与节流）。 */
function createFakeTimers(): {
	setTimer: (callback: () => void, delayMs: number) => number;
	clearTimer: (handle: number) => void;
	now: () => number;
	advance: (ms: number) => void;
} {
	let current = 0;
	let nextHandle = 1;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => current,
		setTimer(callback, delayMs) {
			const handle = nextHandle;
			nextHandle += 1;
			timers.set(handle, { at: current + delayMs, callback });
			return handle;
		},
		clearTimer(handle) {
			timers.delete(handle);
		},
		advance(ms) {
			const target = current + ms;
			for (;;) {
				let dueHandle: number | undefined;
				let dueAt = Number.POSITIVE_INFINITY;
				for (const [handle, timer] of timers) {
					if (timer.at <= target && timer.at < dueAt) {
						dueAt = timer.at;
						dueHandle = handle;
					}
				}
				if (dueHandle === undefined) {
					break;
				}
				const due = timers.get(dueHandle);
				timers.delete(dueHandle);
				if (due !== undefined) {
					current = due.at;
					due.callback();
				}
			}
			current = target;
		},
	};
}

describe("常量：与内置预览对齐的参数", () => {
	it("三层锁的时间常量", () => {
		expect(SCROLL_LOCK_DELAYS_MS).toEqual([50, 100, 200]);
		expect(HOST_SCROLL_LOCK_MS).toBe(200);
		expect(SCROLL_THROTTLE_MS).toBe(50);
	});

	it("snap zone 与滚动下限", () => {
		expect(SNAP_ZONE_RATIO).toBe(0.25);
		expect(MIN_SCROLL_TARGET).toBe(1);
	});
});

describe("findLinePair：几何二分", () => {
	const bounds = [block(1, 0, 20), block(5, 100, 20), block(9, 200, 20)];

	it("取跨越 offset 的 previous / next", () => {
		expect(findLinePair(bounds, 50)?.previous?.line).toBe(1);
		expect(findLinePair(bounds, 50)?.next?.line).toBe(5);
		expect(findLinePair(bounds, 0)?.previous?.line).toBe(1);
		expect(findLinePair(bounds, 100)?.previous?.line).toBe(5);
		expect(findLinePair(bounds, 250)?.next).toBeNull();
		expect(findLinePair(bounds, 250)?.previous?.line).toBe(9);
	});

	it("在所有锚点之前：previous 为 null", () => {
		const pair = findLinePair(bounds, -10);
		expect(pair?.previous).toBeNull();
		expect(pair?.next?.line).toBe(1);
	});

	it("空数组返回 null", () => {
		expect(findLinePair([], 0)).toBeNull();
	});
});

describe("findBoundsForLine：正方向定位", () => {
	const bounds = [block(1, 0, 20), block(5, 100, 20), block(9, 200, 20)];

	it("取最后一个 line <= target 的锚点", () => {
		expect(findBoundsForLine(bounds, 0).previous).toBeNull();
		expect(findBoundsForLine(bounds, 1).previous?.line).toBe(1);
		expect(findBoundsForLine(bounds, 6).previous?.line).toBe(5);
		expect(findBoundsForLine(bounds, 9).previous?.line).toBe(9);
		expect(findBoundsForLine(bounds, 9).next).toBeNull();
		expect(findBoundsForLine(bounds, 99).previous?.line).toBe(9);
	});

	it("空数组返回两端 null", () => {
		expect(findBoundsForLine([], 3)).toEqual({ previous: null, next: null });
	});
});

describe("lineForPageOffset：预览位置 → 行号", () => {
	it("普通块之间线性插值", () => {
		const pair = { previous: block(1, 0, 20), next: block(3, 60, 20) };
		expect(lineForPageOffset(pair, 0)).toBe(1);
		expect(lineForPageOffset(pair, 40)).toBe(2);
		expect(lineForPageOffset(pair, 60)).toBe(3);
	});

	it("多行块内部按内容区（扣 padding）比例插值", () => {
		// 代码块：行 10..15，元素高 100，内容区从 4 起、高 92。
		const pair = {
			previous: block(10, 0, 100, { endLine: 15, contentTop: 4, contentHeight: 92 }),
			next: block(16, 120, 20),
		};
		expect(lineForPageOffset(pair, 4)).toBe(10);
		expect(lineForPageOffset(pair, 4 + 46)).toBe(12.5);
		expect(lineForPageOffset(pair, 96)).toBe(15);
	});

	it("越过最后一个锚点：多行块用 endLine，普通块用 line", () => {
		expect(lineForPageOffset({ previous: block(9, 200, 20), next: null }, 500)).toBe(9);
		const code = block(10, 0, 100, { endLine: 15, contentTop: 0, contentHeight: 100 });
		expect(lineForPageOffset({ previous: code, next: null }, 50)).toBe(12.5);
	});

	it("在所有锚点之前：返回第一个锚点行号", () => {
		expect(lineForPageOffset({ previous: null, next: block(4, 30, 20) }, 0)).toBe(4);
		expect(lineForPageOffset({ previous: null, next: null }, 0)).toBeNull();
		expect(lineForPageOffset(null, 0)).toBeNull();
	});

	it("相邻锚点同一行时不除零", () => {
		expect(lineForPageOffset({ previous: block(5, 10, 20), next: block(5, 40, 20) }, 30)).toBe(5);
	});

	it("插值比例钳制在 0..1", () => {
		const pair = { previous: block(1, 0, 20), next: block(3, 60, 20) };
		expect(lineForPageOffset(pair, 0)).toBe(1);
		expect(lineForPageOffset(pair, Number.NaN)).toBe(1);
	});
});

describe("pageOffsetForLine：行号 → 预览位置（三档插值）", () => {
	it("第 2 档：previous 底边与 next 顶边之间插值", () => {
		const pair = { previous: block(1, 0, 20), next: block(3, 60, 20) };
		expect(pageOffsetForLine(pair, 1)).toBe(0);
		expect(pageOffsetForLine(pair, 2)).toBe(40);
		expect(pageOffsetForLine(pair, 3)).toBe(60);
	});

	it("第 1 档：多行块内按内容区比例", () => {
		const pair = {
			previous: block(10, 0, 100, { endLine: 15, contentTop: 4, contentHeight: 92 }),
			next: block(16, 120, 20),
		};
		expect(pageOffsetForLine(pair, 10)).toBe(4);
		expect(pageOffsetForLine(pair, 12.5)).toBe(50);
		expect(pageOffsetForLine(pair, 15)).toBe(96);
	});

	it("多行块之后仍走第 2 档", () => {
		const pair = {
			previous: block(10, 0, 100, { endLine: 15, contentTop: 4, contentHeight: 92 }),
			next: block(16, 120, 20),
		};
		const offset = pageOffsetForLine(pair, 15.5);
		expect(offset).toBeGreaterThan(100);
		expect(offset).toBeLessThan(120);
	});

	it("第 3 档：没有 next 时按块内小数行比例", () => {
		const pair = { previous: block(3, 10, 30), next: null };
		expect(pageOffsetForLine(pair, 3)).toBe(10);
		expect(pageOffsetForLine(pair, 3.5)).toBe(25);
	});

	it("目标在第一块之前：滚到第一块上沿；空的一对滚到 0", () => {
		expect(pageOffsetForLine({ previous: null, next: block(5, 40, 20) }, 1)).toBe(40);
		expect(pageOffsetForLine({ previous: null, next: null }, 1)).toBe(0);
	});
});

describe("isWithinSnapZone", () => {
	it("视口 1/4 内视为已就位", () => {
		expect(isWithinSnapZone(0, 90, 400)).toBe(true);
		expect(isWithinSnapZone(0, 120, 400)).toBe(false);
		expect(isWithinSnapZone(0, 0, 0)).toBe(true);
		expect(isWithinSnapZone(0, Number.NaN, 400)).toBe(false);
	});
});

describe("createScrollLock：第 1 层防回环锁", () => {
	it("acquire 后锁定，50ms 后自动解锁", () => {
		const timers = createFakeTimers();
		const lock = createScrollLock(SCROLL_LOCK_DELAYS_MS, timers);
		expect(lock.locked).toBe(false);
		lock.acquire();
		expect(lock.locked).toBe(true);
		timers.advance(49);
		expect(lock.locked).toBe(true);
		timers.advance(1);
		expect(lock.locked).toBe(false);
	});

	it("连续 acquire 的抑制窗口按 50 → 100 → 200ms 递增", () => {
		const timers = createFakeTimers();
		const lock = createScrollLock(SCROLL_LOCK_DELAYS_MS, timers);

		lock.acquire();
		timers.advance(10);
		lock.acquire(); // 第二次：100ms（并清掉上一次的 timer）
		timers.advance(50);
		expect(lock.locked).toBe(true);
		timers.advance(50);
		expect(lock.locked).toBe(false);

		lock.acquire();
		timers.advance(10);
		lock.acquire();
		timers.advance(10);
		lock.acquire(); // 第三次：200ms
		timers.advance(199);
		expect(lock.locked).toBe(true);
		timers.advance(1);
		expect(lock.locked).toBe(false);
	});

	it("reset 立即解锁", () => {
		const timers = createFakeTimers();
		const lock = createScrollLock(SCROLL_LOCK_DELAYS_MS, timers);
		lock.acquire();
		lock.reset();
		expect(lock.locked).toBe(false);
		timers.advance(1000);
		expect(lock.locked).toBe(false);
	});

	it("空档位表不会挂死（用 0ms 兜底）", () => {
		const timers = createFakeTimers();
		const lock = createScrollLock([], timers);
		lock.acquire();
		expect(lock.locked).toBe(true);
		timers.advance(0);
		expect(lock.locked).toBe(false);
	});
});

describe("createThrottle：第 3 层 50ms 节流", () => {
	it("首次立即执行，窗口内合并为 trailing 一次", () => {
		const timers = createFakeTimers();
		const seen: number[] = [];
		const throttle = createThrottle<number>(SCROLL_THROTTLE_MS, (value) => seen.push(value), timers);

		throttle.call(1);
		expect(seen).toEqual([1]);
		throttle.call(2);
		throttle.call(3);
		expect(seen).toEqual([1]);
		timers.advance(50);
		expect(seen).toEqual([1, 3]);
	});

	it("窗口过去后再次立即执行", () => {
		const timers = createFakeTimers();
		const seen: number[] = [];
		const throttle = createThrottle<number>(SCROLL_THROTTLE_MS, (value) => seen.push(value), timers);

		throttle.call(1);
		timers.advance(50);
		throttle.call(2);
		expect(seen).toEqual([1, 2]);
	});

	it("cancel 丢弃挂起的 trailing", () => {
		const timers = createFakeTimers();
		const seen: number[] = [];
		const throttle = createThrottle<number>(SCROLL_THROTTLE_MS, (value) => seen.push(value), timers);

		throttle.call(1);
		throttle.call(2);
		throttle.cancel();
		timers.advance(100);
		expect(seen).toEqual([1]);
	});
});
