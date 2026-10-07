// CT-00 契约测试：U-01（schema/命令/capability/结构化错误）、U-02（状态迁移与授权规则）。
// 用例定义见 docs/testing/continuous.md §5；规则来源 docs/specs/continuous.md。
// 运行入口：node scripts/test-continuous.mjs --suite unit（tsx + node:test，不经 shell glob）。

import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
  CONTINUOUS_ERROR_CODES,
  CONTINUOUS_MANAGED_CYCLE_CAPABILITY,
  CONTINUOUS_METHODS,
  CONTINUOUS_OPEN_CYCLE_STATUSES,
  CONTINUOUS_VERIFIED_PLATFORM_EXECUTION,
  assessContinuousPlatformExecution,
  continuousBudgetPolicySchema,
  continuousCapabilityResultSchema,
  continuousCommandContextSchema,
  continuousCycleStatusSchema,
  continuousDecisionPolicySchema,
  continuousErrorSchema,
  continuousPauseProgramParamsSchema,
  continuousProgramStatusSchema,
  continuousRunNowParamsSchema,
  continuousStopCurrentCycleParamsSchema,
  isContinuousError,
  supportsManagedCycles,
} from "@zcode/shared";
// 受控模块公开入口：跨模块只能经 contract.ts，不深入 domain/application 实现细节。
import {
  decisionBlocksProgram,
  isAuthorizationStale,
  isOpenCycleStatus,
  isTerminalCycleStatus,
  requiresProgramReauthorization,
} from "../../src/continuous/contract.js";
import type { Decision, Program } from "../../src/continuous/contract.js";

function validContext(overrides: Record<string, unknown> = {}) {
  return {
    workspacePath: "/repos/app",
    workspaceIdentity: "remote-identity-1",
    workspaceKey: "remote-identity-1",
    traceId: "trace-1",
    ...overrides,
  };
}

function makeProgram(revision = 4): Program {
  return {
    id: "program-1",
    workspaceKey: "remote-identity-1",
    workspacePath: "/repos/app",
    revision,
    goal: "持续改进桌面 Web UI",
    timeZone: "Asia/Shanghai",
    scope: {
      allowedPaths: ["packages/ui/src"],
      forbiddenPaths: ["packages/services/src/session/tasksDatabase"],
      forbiddenCapabilities: ["backend_rewrite", "db_migration", "deploy"],
    },
    budget: CONTINUOUS_DEFAULT_BUDGET,
    cadence: CONTINUOUS_DEFAULT_CADENCE,
    decisionPolicy: continuousDecisionPolicySchema.parse({ unknownToDecision: true }),
    authorization: { revision, templateHash: "a".repeat(64), grantedAt: "2026-10-04T00:00:00Z" },
    templateId: "ui-ux-v1",
    templateVersion: "1",
    templateHash: "a".repeat(64),
    status: "active",
    consecutiveFailures: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}

// ── U-01：schema/命令/capability/结构化错误 ──

test("U-01 非法状态被严格 schema 拒绝", () => {
  assert.equal(continuousProgramStatusSchema.parse("paused"), "paused");
  assert.equal(continuousCycleStatusSchema.parse("suspended"), "suspended");
  assert.equal(continuousProgramStatusSchema.safeParse("bogus").success, false);
  assert.equal(continuousProgramStatusSchema.safeParse("running").success, false);
  assert.equal(continuousCycleStatusSchema.safeParse("done").success, false);
  assert.equal(continuousCycleStatusSchema.safeParse("active").success, false);
});

test("U-01 缺 identity / epoch 的命令被拒绝", () => {
  // context 缺 workspacePath / traceId
  assert.equal(
    continuousCommandContextSchema.safeParse({ workspaceKey: "/repos/app" }).success,
    false,
  );
  // workspaceKey 不符合 identity fallback 规则
  assert.equal(
    continuousCommandContextSchema.safeParse({
      workspacePath: "/repos/app",
      workspaceKey: "wrong-key",
      traceId: "trace-1",
    }).success,
    false,
  );
  // 身份规则：identity 优先（trim 后），缺省回退 workspacePath
  assert.equal(
    continuousCommandContextSchema.parse(validContext()).workspaceKey,
    "remote-identity-1",
  );
  assert.equal(
    continuousCommandContextSchema.parse(
      validContext({ workspaceIdentity: undefined, workspaceKey: "/repos/app" }),
    ).workspaceKey,
    "/repos/app",
  );
  // 命令缺 epoch / cycleId 被拒
  const base = { context: validContext(), programId: "program-1" };
  assert.equal(
    continuousStopCurrentCycleParamsSchema.safeParse({
      ...base,
      cycleId: "cycle-1",
      reason: "user_request",
    }).success,
    false,
  );
  assert.equal(
    continuousStopCurrentCycleParamsSchema.safeParse({
      ...base,
      epoch: 2,
      reason: "user_request",
    }).success,
    false,
  );
  assert.equal(
    continuousStopCurrentCycleParamsSchema.safeParse({
      ...base,
      cycleId: "cycle-1",
      epoch: 2,
      reason: "user_request",
    }).success,
    true,
  );
});

test("U-01 无 capability 拒绝：旧 capability 不能误启动 managed cycle", () => {
  assert.equal(supportsManagedCycles(null), false);
  assert.equal(supportsManagedCycles(undefined), false);
  assert.equal(supportsManagedCycles(true), false);
  // 既有 v4 Host capability 形状（transport.ts hostCapabilitiesSchema）不得触发
  assert.equal(
    supportsManagedCycles({
      nativeDialogs: true,
      localTerminal: true,
      binaryFrames: true,
      compression: "permessage-deflate",
      workspaceHookReview: true,
      independentPlanState: true,
      workflowRunDeltas: true,
    }),
    false,
  );
  // 声明了 supported 但 capability 名不是专用位，同样拒绝
  assert.equal(
    supportsManagedCycles({ supported: true, capability: "workflowRunDeltas", version: 1 }),
    false,
  );
  // supported 必须严格 === true；false/缺失都不是启动许可
  assert.equal(
    supportsManagedCycles(
      continuousCapabilityResultSchema.parse({
        supported: false,
        capability: CONTINUOUS_MANAGED_CYCLE_CAPABILITY,
        version: 0,
      }),
    ),
    false,
  );
  assert.equal(
    supportsManagedCycles(
      continuousCapabilityResultSchema.parse({
        supported: true,
        capability: CONTINUOUS_MANAGED_CYCLE_CAPABILITY,
        version: 1,
      }),
    ),
    true,
  );
});

test("U-01 结构化错误形状稳定且覆盖规格 §11 错误清单", () => {
  const specCodes = [
    "authorization_stale",
    "scope_denied",
    "budget_denied",
    "usage_unknown",
    "lease_lost",
    "execution_not_quiescent",
    "execution_identity_mismatch",
    "template_mismatch",
    "remote_execution_not_supported",
    "validation_unavailable",
  ];
  for (const code of specCodes) {
    assert.ok(
      (CONTINUOUS_ERROR_CODES as readonly string[]).includes(code),
      `缺少规格要求的错误码: ${code}`,
    );
    const parsed = continuousErrorSchema.parse({ code, message: "detail", retryable: false });
    assert.deepEqual(Object.keys(parsed).sort(), ["code", "message", "retryable"]);
  }
  // capability_missing 是旧 CLI 拒绝的独立错误码
  assert.ok((CONTINUOUS_ERROR_CODES as readonly string[]).includes("capability_missing"));
  // CT-14 additive：读操作通信期限超时/传输失败的独立错误码（消息携带期限事实）
  assert.ok((CONTINUOUS_ERROR_CODES as readonly string[]).includes("execution_unreachable"));
  assert.equal(
    continuousErrorSchema.parse({
      code: "execution_unreachable",
      message: "continuous wire inspectHealth 通信超时（30000ms 期限，CT-14 §10.1）",
      retryable: false,
    }).code,
    "execution_unreachable",
  );
  assert.equal(isContinuousError({ code: "budget_denied", message: "x", retryable: false }), true);
  assert.equal(isContinuousError({ code: "budget_denied", message: "x" }), false);
  assert.equal(
    isContinuousError({ code: "not_a_continuous_error", message: "x", retryable: false }),
    false,
  );
  assert.equal(isContinuousError(new Error("boom")), false);
});

test("U-01 兼容性：命令词表与默认值经 @zcode/shared 公开入口可用", () => {
  // 旧 capability 不能误启动的另一面：命令方法名独立成 continuous/* 命名空间，
  // 不复用 automation/* 或 v4/* 既有方法名。
  assert.equal(CONTINUOUS_METHODS.pauseProgram, "continuous/pauseProgram");
  assert.equal(CONTINUOUS_METHODS.stopCurrentCycle, "continuous/stopCurrentCycle");
  assert.notEqual(CONTINUOUS_METHODS.pauseProgram, CONTINUOUS_METHODS.stopCurrentCycle);
  for (const method of Object.values(CONTINUOUS_METHODS)) {
    assert.ok(method.startsWith("continuous/"));
  }
  // 默认值与规格 §2 一致（金额为整数微美元）
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.dailyCostUsdMicros, 1_000_000_000);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.perCycleCostUsdMicros, 100_000_000);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.perCycleTokens, 1_000_000_000);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.perCycleMaxImprovements, 3);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.perCycleMaxFiles, 10);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.perCycleMaxChangedLines, 400);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.maxConcurrentActors, 10);
  assert.equal(CONTINUOUS_DEFAULT_BUDGET.activeExecutionLimitMs, 3_600_000);
  assert.equal(CONTINUOUS_DEFAULT_CADENCE.kind, "interval");
  assert.deepEqual(CONTINUOUS_DEFAULT_CADENCE, { kind: "interval", hoursAfterCycleEnd: 6 });
  // 预算 schema：每日可 Unlimited（null），单轮必须是正的有限值
  assert.equal(
    continuousBudgetPolicySchema.safeParse({
      ...CONTINUOUS_DEFAULT_BUDGET,
      dailyCostUsdMicros: null,
    }).success,
    true,
  );
  assert.equal(
    continuousBudgetPolicySchema.safeParse({
      ...CONTINUOUS_DEFAULT_BUDGET,
      perCycleCostUsdMicros: 0,
    }).success,
    false,
  );
  assert.equal(
    continuousBudgetPolicySchema.safeParse({
      ...CONTINUOUS_DEFAULT_BUDGET,
      perCycleCostUsdMicros: 1.5,
    }).success,
    false,
  );
});

test("U-01 CT-10 additive：平台能力契约（登记表/评估/capability 可选字段/错误码）", () => {
  // §13 固定能力规则：未登记平台 fail closed（observe_only + 稳定原因 token）。
  const unverified = assessContinuousPlatformExecution({ platform: "win32", arch: "x64" });
  assert.deepEqual(unverified, {
    mode: "observe_only",
    platformKey: "win32-x64",
    verified: false,
    reason: "platform_not_verified",
  });
  // 登记表条目必须携带证据出处与实测覆盖面（追加平台 = 随附 suite 证据）。
  for (const [platformKey, fact] of Object.entries(CONTINUOUS_VERIFIED_PLATFORM_EXECUTION)) {
    assert.ok(fact.verifiedAt.length > 0, `${platformKey} 登记缺 verifiedAt`);
    assert.ok(fact.evidence.length > 0, `${platformKey} 登记缺 evidence 出处`);
    assert.ok(fact.verifiedScopes.length > 0, `${platformKey} 登记缺实测覆盖面`);
    const assessment = assessContinuousPlatformExecution({
      platform: platformKey.split("-")[0]!,
      arch: platformKey.split("-")[1]!,
    });
    assert.equal(assessment.mode, "autonomous");
    assert.equal(assessment.platformKey, platformKey);
  }
  // capability 结果的可选 platform 字段：旧形状（无 platform）仍合法（additive）；
  // 带字段的形状必须经 strict schema。
  assert.equal(
    continuousCapabilityResultSchema.safeParse({
      supported: true,
      capability: "continuousManagedCycles",
      version: 1,
    }).success,
    true,
    "无 platform 的旧 capability 形状必须继续合法",
  );
  const withPlatform = continuousCapabilityResultSchema.parse({
    supported: true,
    capability: "continuousManagedCycles",
    version: 1,
    platform: { mode: "observe_only", platformKey: "win32-x64", verified: false },
  });
  assert.equal(withPlatform.platform?.mode, "observe_only");
  assert.equal(
    continuousCapabilityResultSchema.safeParse({
      supported: true,
      capability: "continuousManagedCycles",
      version: 1,
      platform: { mode: "something_else" },
    }).success,
    false,
    "platform 字段非法值必须被拒绝",
  );
  // 错误词表 additive：platform_execution_not_supported 在 wire 词表内且可被结构化错误解析。
  assert.ok(
    (CONTINUOUS_ERROR_CODES as readonly string[]).includes("platform_execution_not_supported"),
  );
  assert.equal(
    isContinuousError({
      code: "platform_execution_not_supported",
      message: "x",
      retryable: false,
    }),
    true,
  );
});

// ── U-02：状态迁移与授权 ──

test("U-02 pending Decision 不暂停 Program、不阻塞整轮", () => {
  const pendingBlocking: Pick<Decision, "status" | "classification" | "blockingScope"> = {
    status: "pending",
    classification: "blocking",
    blockingScope: {
      candidateIds: ["candidate-1"],
      paths: ["packages/ui/src/settings"],
      capability: "navigation_architecture",
    },
  };
  // 规格规则：pending Decision 不改变 Program 状态、不默认阻止当前 Cycle
  assert.equal(decisionBlocksProgram(pendingBlocking), false);
  assert.equal(decisionBlocksProgram({ status: "pending", classification: "deferred" }), false);
});

test("U-02 Goal/Scope/模板/模型变更撤销授权，预算/cadence 不撤销", () => {
  assert.equal(requiresProgramReauthorization("goal"), true);
  assert.equal(requiresProgramReauthorization("scope"), true);
  assert.equal(requiresProgramReauthorization("template"), true);
  assert.equal(requiresProgramReauthorization("model"), true);
  // 单纯预算增加/降低与 cadence 修改不扩大 Scope：原授权继续有效
  assert.equal(requiresProgramReauthorization("budget"), false);
  assert.equal(requiresProgramReauthorization("cadence"), false);
  // 旧 revision 的命令必须判 stale（authorization_stale）
  const program = makeProgram(4);
  assert.equal(isAuthorizationStale(program, 3), true);
  assert.equal(isAuthorizationStale(program, 4), false);
});

test("U-02 Pause 与立即停止本轮是两个命令，pause 无立即旁路", () => {
  const base = { context: validContext(), programId: "program-1" };
  // pause 是 strict schema：不存在 immediate/force 之类的旁路字段
  assert.equal(continuousPauseProgramParamsSchema.safeParse(base).success, true);
  assert.equal(
    continuousPauseProgramParamsSchema.safeParse({ ...base, immediate: true }).success,
    false,
  );
  assert.equal(
    continuousPauseProgramParamsSchema.safeParse({ ...base, force: true }).success,
    false,
  );
  // 立即停止必须携带 cycleId + epoch + reason（撤销写入 → 取消 → 等待停止）
  assert.equal(
    continuousStopCurrentCycleParamsSchema.safeParse({
      ...base,
      cycleId: "cycle-1",
      epoch: 2,
      reason: "not_a_reason",
    }).success,
    false,
  );
  // runNow 幂等键：manual trigger 必须携带 requestId
  assert.equal(continuousRunNowParamsSchema.safeParse(base).success, false);
  assert.equal(
    continuousRunNowParamsSchema.safeParse({ ...base, requestId: "req-1" }).success,
    true,
  );
});

test("U-02 开放/终态 Cycle 词表与规格 §5/§6 一致", () => {
  assert.deepEqual(
    [...CONTINUOUS_OPEN_CYCLE_STATUSES],
    ["preparing", "running", "settling", "interrupted", "suspended"],
  );
  assert.equal(isOpenCycleStatus("suspended"), true);
  assert.equal(isOpenCycleStatus("preparing"), true);
  assert.equal(isTerminalCycleStatus("completed"), true);
  assert.equal(isTerminalCycleStatus("failed"), true);
  assert.equal(isTerminalCycleStatus("cancelled"), true);
  assert.equal(isTerminalCycleStatus("running"), false);
});
