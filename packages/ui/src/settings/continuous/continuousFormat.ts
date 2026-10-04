// Continuous 页面的纯展示规则（CT-08）：i18n key 映射、金额/时长格式化。
// 不做任何业务判定（阻塞/授权/预算裁决都在服务端）；这里只回答「这个状态显示什么」。
// 状态不靠颜色表达（E-22）：每个状态都有文字标签，颜色只是辅助。

import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type {
  ContinuousCadencePolicy,
  ContinuousCandidateStatus,
  ContinuousCycleHealthState,
  ContinuousCycleStatus,
  ContinuousDecisionStatus,
  ContinuousProgramStatus,
  ContinuousUsageSummary,
} from "@zcode/shared";

type FormatMessage = IntlInstance["formatMessage"];

export function continuousProgramStatusLabel(
  formatMessage: FormatMessage,
  status: ContinuousProgramStatus,
): string {
  return formatMessage({ id: `continuous.programStatus.${status}` });
}

export function continuousCycleStatusLabel(
  formatMessage: FormatMessage,
  status: ContinuousCycleStatus,
): string {
  return formatMessage({ id: `continuous.cycleStatus.${status}` });
}

export function continuousHealthLabel(
  formatMessage: FormatMessage,
  health: ContinuousCycleHealthState,
): string {
  return formatMessage({ id: `continuous.health.${health}` });
}

export function continuousCandidateStatusLabel(
  formatMessage: FormatMessage,
  status: ContinuousCandidateStatus,
): string {
  return formatMessage({ id: `continuous.candidateStatus.${status}` });
}

export function continuousDecisionStatusLabel(
  formatMessage: FormatMessage,
  status: ContinuousDecisionStatus,
): string {
  return formatMessage({ id: `continuous.decisionStatus.${status}` });
}

export function continuousContinuationReasonLabel(
  formatMessage: FormatMessage,
  reason: string,
): string {
  return formatMessage({ id: `continuous.continuationReason.${reason}` });
}

export function continuousLimitKindLabel(formatMessage: FormatMessage, limitKind: string): string {
  return formatMessage({ id: `continuous.limitKind.${limitKind}` });
}

/** 微美元 → 用户可读金额。金额一律“估算”：显示值永远带 ≈ 前缀语义（D3，不声称与账单一致）。 */
export function formatContinuousUsdMicros(micros: number, locale: string): string {
  const usd = micros / 1_000_000;
  return `≈ ${new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: usd >= 100 ? 0 : 2,
  }).format(usd)}`;
}

/** token 数用紧凑计数（1,000,000,000 → 1B / 10 亿），完整值进 title。 */
export function formatContinuousTokens(tokens: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 2 }).format(
    tokens,
  );
}

/** 用量摘要的一行事实：已结算（估）+ 未结算（保留）分开——unknown 不被清零也不被混入。 */
export function describeContinuousUsage(
  summary: ContinuousUsageSummary,
  locale: string,
): { settled: string; unsettled: string; settledTokens: string; unsettledTokens: string } {
  return {
    settled: formatContinuousUsdMicros(summary.settledCostMicros, locale),
    unsettled: formatContinuousUsdMicros(summary.unsettledCostMicros, locale),
    settledTokens: formatContinuousTokens(summary.settledTokens, locale),
    unsettledTokens: formatContinuousTokens(summary.unsettledTokens, locale),
  };
}

/** 毫秒时长 → 人读（有效执行/正常等待/墙钟共用；不隐藏单位）。 */
export function formatContinuousDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** cadence 摘要：interval=上一轮结束后 N 小时；daily=每天本地时间（时区）。 */
export function describeContinuousCadence(
  formatMessage: FormatMessage,
  cadence: ContinuousCadencePolicy,
): string {
  if (cadence.kind === "interval") {
    return formatMessage(
      { id: "continuous.cadence.interval" },
      { hours: String(cadence.hoursAfterCycleEnd) },
    );
  }
  return formatMessage(
    { id: "continuous.cadence.daily" },
    { time: cadence.localTime, timeZone: cadence.timeZone },
  );
}

/** 微美元表单字段 ↔ 用户输入（美元）。表单以 USD 为单位展示，存储/传输用微美元整数。 */
export function usdMicrosToInput(micros: number): string {
  return String(micros / 1_000_000);
}

export function inputToUsdMicros(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  const micros = Math.round(value * 1_000_000);
  // E-34：超出安全整数的 grant/额度直接拒绝，不在界面静默截断。
  return Number.isSafeInteger(micros) ? micros : null;
}

export function inputToPositiveInt(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0 || !Number.isSafeInteger(value)) return null;
  return value;
}
