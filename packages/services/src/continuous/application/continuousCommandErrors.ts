// Continuous 命令层错误映射（CT-08）：服务栈错误 → 结构化 ContinuousError。
// 拆出独立文件（continuousCommandService 的 max-lines 约束）；命令门面与继续确认命令
// 共用同一份映射，避免两处各写一套 code 归类迟早漂移。

import {
  CONTINUOUS_ERROR_CODES,
  type ContinuousCommandContext,
  type ContinuousError,
  type ContinuousErrorCode,
} from "@zcode/shared";
import type { Program } from "../domain/types.js";
import type { ContinuousRepositoryPort } from "./ports.js";
import { DecisionVersionConflictError } from "./decisionService.js";
import { ContinuationVersionConflictError } from "./continuationService.js";

const WIRE_CODES = new Set<string>(CONTINUOUS_ERROR_CODES);

/** 命令层结构化错误：code 全部来自 CONTINUOUS_ERROR_CODES（wire 词表），不透传堆栈。 */
export class ContinuousCommandError extends Error {
  constructor(readonly error: ContinuousError) {
    super(error.message);
    this.name = "ContinuousCommandError";
  }
}

export function commandError(
  code: ContinuousErrorCode,
  message: string,
  retryable = false,
): ContinuousCommandError {
  return new ContinuousCommandError({ code, message, retryable });
}

/** 服务栈错误 → 结构化命令错误。未知错误原样上抛（bug 不该被伪装成业务回执）。 */
export function toCommandError(error: unknown): unknown {
  if (error instanceof ContinuousCommandError) return error;
  if (error instanceof DecisionVersionConflictError) {
    return commandError("version_conflict", error.message);
  }
  if (error instanceof ContinuationVersionConflictError) {
    return commandError("version_conflict", error.message);
  }
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") {
      // supervisor 栈（ContinuousSupervisorError）的 code 已在 wire 词表内（含 CT-08
      // additive 的 program_not_runnable/open_cycle_exists）；repository 的 not_found 家族
      // 与 supervisorControl 的先例一致落 capability_missing（对象不存在，对 UI 是同一
      // 处置：该 workspace 没有这个对象）。
      if (
        code === "not_found" ||
        code === "program_mismatch" ||
        code === "cycle_program_mismatch"
      ) {
        return commandError("capability_missing", error.message);
      }
      if (WIRE_CODES.has(code)) return commandError(code as ContinuousErrorCode, error.message);
    }
  }
  return error;
}

/** 命令的归属门：Program 必须存在且属于命令携带的 workspace（防跨 workspace 误操作；
 * workspaceKey 规则 = workspaceIdentity?.trim() || workspacePath，context 已按此构造）。 */
export async function requireProgramOf(
  repository: ContinuousRepositoryPort,
  params: { context: ContinuousCommandContext; programId: string },
): Promise<Program> {
  const program = await repository.getProgram(params.programId);
  if (!program) {
    throw commandError("capability_missing", `program 不存在: ${params.programId}`);
  }
  if (program.workspaceKey !== params.context.workspaceKey) {
    throw commandError(
      "capability_missing",
      `program ${program.id} 不属于 workspace ${params.context.workspaceKey}`,
    );
  }
  return program;
}
