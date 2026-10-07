// Continuous 预算协议（CT-04）：价格快照 schema 与微美元整数估算的单一实现。
// 唯一产品规则来源：docs/specs/continuous.md §9（预算和请求所有权）。CLI 侧预算闸门
// （bootstrap continuous-model-budget.ts）与 Host 侧账本（services budgetAdmission）
// 必须用同一份价格数学，否则预留与结算会出现两套数——所以放 shared，不在两侧各写一遍。
// 本文件只做纯计算与传输校验，不含业务实现、不做 IO。

import { z } from "zod";

const nonEmptyString = z.string().min(1);
const nonNegativeInt = z.number().int().nonnegative();
const positiveInt = z.number().int().positive();

/** 单个 provider/model 的单价：每百万 token 的微美元整数（USD/M × 1e6）。 */
export const continuousModelPriceSchema = z.strictObject({
  providerId: nonEmptyString,
  modelId: nonEmptyString,
  /** 输入侧（含 cache 写入等按输入计价的部分）每百万 token 的微美元。 */
  inputMicrosPerMillionTokens: nonNegativeInt,
  /** 输出侧每百万 token 的微美元。 */
  outputMicrosPerMillionTokens: nonNegativeInt,
});
export type ContinuousModelPrice = z.infer<typeof continuousModelPriceSchema>;

/**
 * 价格快照：带版本号的单价表。reservation 落库时记录 pricing_version，
 * 事后可解释「这笔预留用的是哪张快照」。价格缺失即拒绝（规格 §9），不存在零价兜底。
 */
export const continuousPriceSnapshotSchema = z.strictObject({
  pricingVersion: nonEmptyString,
  prices: z.array(continuousModelPriceSchema),
});
export type ContinuousPriceSnapshot = z.infer<typeof continuousPriceSnapshotSchema>;

/** 快照内查单价；同一 provider/model 重复时取第一条（装配层保证唯一，这里不静默合并）。 */
export function lookupContinuousModelPrice(
  snapshot: ContinuousPriceSnapshot,
  providerId: string,
  modelId: string,
): ContinuousModelPrice | undefined {
  return snapshot.prices.find(
    (price) => price.providerId === providerId && price.modelId === modelId,
  );
}

/** 微美元取整：向上（保守侧——预留宁可多不可少）。 */
function ceilDiv(microsPerMillion: number, tokens: number): number {
  if (tokens <= 0) return 0;
  return Math.ceil((microsPerMillion * tokens) / 1_000_000);
}

export interface ContinuousCostEstimate {
  inputMicros: number;
  outputMicros: number;
  totalMicros: number;
}

/**
 * 按价格快照估算一次请求的费用（整数微美元，分量各自向上取整后相加）。
 * 预留（保守：用请求 token 上限）与结算（用实际 usage）共用本函数。
 * 输入 token 数缺席时按 0 计——调用方（闸门/结算侧）负责在预留路径强制上限在场。
 */
export function estimateContinuousRequestCostMicros(input: {
  price: Pick<ContinuousModelPrice, "inputMicrosPerMillionTokens" | "outputMicrosPerMillionTokens">;
  inputTokens: number;
  outputTokens: number;
}): ContinuousCostEstimate {
  const inputMicros = ceilDiv(input.price.inputMicrosPerMillionTokens, input.inputTokens);
  const outputMicros = ceilDiv(input.price.outputMicrosPerMillionTokens, input.outputTokens);
  return { inputMicros, outputMicros, totalMicros: inputMicros + outputMicros };
}

/** 单请求保守预留的输入/输出 token 上限（规格 §9「每个请求必须有输入上限和输出上限」）。 */
export const continuousRequestCapsSchema = z.strictObject({
  inputTokenCap: positiveInt,
  outputTokenCap: positiveInt,
});
export type ContinuousRequestCaps = z.infer<typeof continuousRequestCapsSchema>;
