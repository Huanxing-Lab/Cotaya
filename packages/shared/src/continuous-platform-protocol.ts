// Continuous 平台能力契约（CT-10，规格 §13「固定能力规则」）。
//
// 唯一产品规则来源：docs/specs/continuous.md §13——「跨平台没有可验证的写入/命令限制时，
// 该平台只提供观察，不开放自动实施」。本文件是该规则的单一实现：
//   - CONTINUOUS_VERIFIED_PLATFORM_EXECUTION 是已验证平台登记表；登记依据是 platform suite
//     在真实机器上的实测证据（docs/release/continuous.md 的逐平台证据表）。追加平台必须
//     同时提交该平台 suite 证据，不允许凭代码审查登记。
//   - assessContinuousPlatformExecution 是纯评估函数：Host 装配（supervisor 启动门 /
//     capability 投影）与 CLI 执行策略共用，不各自维护第二套平台清单。
//
// 拆分为独立文件而不是并入 continuous-protocol.ts：后者已到 oxlint max-lines 上限
// （CT-08 起 continuous-ui-protocol / budget / execution / report 同款惯例），公开路径仍经
// continuous-protocol.ts `export *` 再导出，不变。

import { z } from "zod";

/**
 * 平台执行模式：
 * - autonomous —— 该平台已验证可可靠限制文件/命令，开放自主实施；
 * - observe_only —— 未验证平台：只提供观察（读面可用），不开放自动实施。
 */
export type ContinuousPlatformExecutionMode = "autonomous" | "observe_only";

export const continuousPlatformExecutionModeSchema = z.enum(["autonomous", "observe_only"]);

/** 已验证平台的登记事实（证据出处 + 日期）；向登记表追加条目必须随附 platform suite 证据。 */
export interface ContinuousPlatformVerificationFact {
  /** 验证日期（ISO 日期字符串）。 */
  verifiedAt: string;
  /** 证据文档（仓库相对路径）。 */
  evidence: string;
  /** 实测覆盖面摘要（路径/进程树取消/worktree/SQL/命令限制等）。 */
  verifiedScopes: string[];
}

/**
 * 已验证平台登记表（platformKey = `<platform>-<arch>`）。
 * 当前仅 darwin-arm64 有真实机器实测（本仓库 CT-10 执行环境）；darwin-x64、win32、linux
 * 均未在本仓库验证过，评估结果为 observe_only——这是如实状态，不是产品待办。
 */
export const CONTINUOUS_VERIFIED_PLATFORM_EXECUTION: Readonly<
  Record<string, ContinuousPlatformVerificationFact>
> = {
  "darwin-arm64": {
    verifiedAt: "2026-10-05",
    evidence: "docs/release/continuous.md",
    verifiedScopes: [
      "paths-spaces-unicode-case-symlink",
      "process-tree-cancel",
      "worktree",
      "sql-constraints",
      "command-restriction",
    ],
  },
};

/** 平台能力评估结果（wire 形状；capability 结果经此上送 UI，E-24「可观察的模式明确只读」）。 */
export const continuousPlatformExecutionSchema = z.strictObject({
  mode: continuousPlatformExecutionModeSchema,
  platformKey: z.string().min(1),
  verified: z.boolean(),
  /** observe_only 的稳定原因 token（日志/审计用；UI 文案走 i18n，不翻译本字段）。 */
  reason: z.string().optional(),
});
export type ContinuousPlatformExecution = z.infer<typeof continuousPlatformExecutionSchema>;

/**
 * 评估某平台能否开放自主实施。纯函数：输入 process.platform/process.arch（或测试注入的
 * 任意值），输出模式与登记事实；未登记平台一律 observe_only（fail closed，规格 §13）。
 */
export function assessContinuousPlatformExecution(input: {
  platform: string;
  arch: string;
}): ContinuousPlatformExecution {
  const platformKey = `${input.platform}-${input.arch}`;
  const fact = CONTINUOUS_VERIFIED_PLATFORM_EXECUTION[platformKey];
  if (fact === undefined) {
    return {
      mode: "observe_only",
      platformKey,
      verified: false,
      reason: "platform_not_verified",
    };
  }
  return { mode: "autonomous", platformKey, verified: true };
}
