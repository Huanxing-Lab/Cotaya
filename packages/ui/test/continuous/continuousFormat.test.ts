// CT-08 UI 纯展示规则测试：金额/时长/token 格式化、微美元输入换算与安全整数拒绝。
// 用例对应 docs/testing/continuous.md 的 E-34（默认值与大整数无截断）与 §12（费用标“估算”、
// unknown 单列）的展示面。运行入口：node scripts/test-continuous.mjs --suite unit。
import assert from "node:assert/strict";
import test from "node:test";
import { CONTINUOUS_DEFAULT_BUDGET } from "@zcode/shared";
import {
  describeContinuousUsage,
  formatContinuousDuration,
  formatContinuousTokens,
  formatContinuousUsdMicros,
  inputToPositiveInt,
  inputToUsdMicros,
  usdMicrosToInput,
} from "../../src/settings/continuous/continuousFormat.js";

test("金额显示带估算前缀且不宣称与账单一致（D3/§12）", () => {
  const text = formatContinuousUsdMicros(CONTINUOUS_DEFAULT_BUDGET.perCycleCostUsdMicros, "en-US");
  assert.ok(text.startsWith("≈"));
  assert.ok(text.includes("100"));
  // 大额走整位（可读），小额保留两位小数
  assert.ok(formatContinuousUsdMicros(1_500_000, "en-US").includes("1.5"));
});

test("token 紧凑计数：10 亿显示为 B 量级，不丢数量级（E-34）", () => {
  const text = formatContinuousTokens(CONTINUOUS_DEFAULT_BUDGET.perCycleTokens, "en-US");
  assert.match(text, /B/);
  assert.equal(formatContinuousTokens(1500, "en-US"), "1.5K");
});

test("时长格式化：小时/分钟/秒分层，负数与非有限值显示占位", () => {
  assert.equal(formatContinuousDuration(3_600_000), "1h 0m");
  assert.equal(formatContinuousDuration(65_000), "1m 5s");
  assert.equal(formatContinuousDuration(4_500), "4s");
  assert.equal(formatContinuousDuration(-1), "—");
  assert.equal(formatContinuousDuration(Number.NaN), "—");
});

test("用量摘要：已结算与未结算（保留）分开输出，不合并成单一数字（§9/§12）", () => {
  const usage = describeContinuousUsage(
    {
      settledCostMicros: 10_000_000,
      unsettledCostMicros: 2_500_000,
      settledTokens: 1_000_000,
      unsettledTokens: 500,
    },
    "en-US",
  );
  assert.notEqual(usage.settled, usage.unsettled);
  assert.ok(usage.settled.startsWith("≈"));
  assert.ok(usage.unsettled.startsWith("≈"));
  assert.ok(usage.settledTokens.length > 0);
  assert.ok(usage.unsettledTokens.length > 0);
});

test("微美元输入换算：USD↔micros 往返一致；非法值返回 null 而不是 0", () => {
  assert.equal(inputToUsdMicros("100"), 100_000_000);
  assert.equal(inputToUsdMicros(" 0.5 "), 500_000);
  assert.equal(usdMicrosToInput(100_000_000), "100");
  assert.equal(inputToUsdMicros(""), null);
  assert.equal(inputToUsdMicros("0"), null);
  assert.equal(inputToUsdMicros("-5"), null);
  assert.equal(inputToUsdMicros("abc"), null);
});

test("安全整数边界：超出 2^53-1 的额度/grant 被拒绝，不静默截断（E-34）", () => {
  // (2^53) USD → 超出微美元安全整数范围
  assert.equal(inputToUsdMicros("9007199254740992"), null);
  assert.equal(inputToUsdMicros("100"), 100_000_000);
  assert.equal(inputToPositiveInt("10000000000000000000"), null);
  assert.equal(inputToPositiveInt("1000000000"), 1_000_000_000);
  assert.equal(inputToPositiveInt("1.5"), null);
  assert.equal(inputToPositiveInt("0"), null);
});
