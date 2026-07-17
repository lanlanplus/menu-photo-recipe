import assert from "node:assert/strict";
import test from "node:test";
import { createRunningTimer, formatTimer, remainingTimerSeconds } from "./timer.js";

test("计时器格式化为分秒", () => {
  assert.equal(formatTimer(65), "01:05");
  assert.equal(formatTimer(0), "00:00");
});

test("倒计时根据绝对结束时间计算，切换页面不会改变进度", () => {
  const timer = createRunningTimer(60, 60, "测试计时", 1_000);
  assert.equal(remainingTimerSeconds(timer.endAt, 31_000), 30);
  assert.equal(remainingTimerSeconds(timer.endAt, 61_000), 0);
});
