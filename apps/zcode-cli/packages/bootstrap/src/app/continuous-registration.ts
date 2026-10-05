// ============================================================
// Continuous managed run 登记处（CT-12）：CLI 进程内按 Run ID 构造预算/决策/IO 端口
// ============================================================
// Host 在 submitOnce 前经专用 v4 命令 continuousRegisterManagedRun 下发一轮的冻结事实
//（Scope/角色/变更量/声明测试命令/价格快照/请求上限/尝试上限/leaseEpoch/真实工作目录，
// wire schema 在 @zcode/shared continuous-registration-protocol）。本文件把载荷变成三类
// **进程内端口**并登记进 create-app 的 continuousManagedCycles 注册处：
//   - 预算闸门（continuous-model-budget）：账本走 CLI→Host 的 continuous/ledger/* 请求，
//     断联折算 ledger_unreachable，本地不扩额（§9）；
//   - 决策闸门（continuous-decision-adapter）：持久化走 continuous/decision/escalate 请求
//    （先持久化再撤销候选写许可，§8）；
//   - IO 登记（continuous-managed-guards）：fd 绑定文件端口 + 受限搜索 + 受控声明测试 +
//     可信工具端口（CT-11 的全部执行点；浏览器证据提供方缺席时如实 unverified）。
//
// 与执行适配器（continuous-execution-adapter）共享同一准入状态：预算/IO 的
// waitForAdmission/admissionProbe 都指向适配器的本地准许（挂起冻结新请求、继续解冻、
// 用户停止撤销——§6.1/§2.1 的 CLI 侧半边）。模型预算与 IO 因此绑定**同一准入**，不能各自
// 第二套状态。
//
// 拒绝语义：登记失败（载荷非法/执行权过期）结构化拒绝，**不给** Host 自主实施 capability；
// 老 Host 不发登记命令时注册处为空，submitOnce 前的守卫（requireContinuousManagedGuards）
// 照样拒绝——双向 fail closed，不退回普通 Workflow 端口。

import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import type { z } from "zod";
import type { ContinuousRegisterManagedRunCommand } from "@zcode/shared/continuous-protocol";
import {
  wireDecisionSink,
  wireLedger,
  wireSuspendForChangeLimit,
  wireSuspensionWait,
  type ContinuousWireAgentPortDeps,
} from "./continuous-wire-agent-ports.js";
import {
  createContinuousCandidateGrantHolder,
  createContinuousDecisionGate,
} from "./continuous-decision-adapter.js";
import { createContinuousEvidenceRegistry } from "./continuous-evidence.js";
import { createContinuousConfinedTestRunner } from "./continuous-confined-execution.js";
import {
  createDarwinSeatbeltProvider,
  type ContinuousIsolationProvider,
} from "./continuous-isolation.js";
import { createContinuousModelBudgetGate } from "./continuous-model-budget.js";
import { createContinuousTrustedPorts } from "./continuous-trusted-ports.js";
import type {
  ContinuousActorRole,
  ContinuousExecutionPolicyConfig,
} from "./continuous-execution-policy.js";
import type { ContinuousActorIoPolicy } from "./continuous-io-guards.js";
import type { ContinuousManagedIoRegistration } from "./continuous-managed-guards.js";
import type { ContinuousExecutionPort } from "./continuous-execution-adapter.js";
import { assessContinuousPlatformExecution } from "@zcode/shared/continuous-protocol";

/** CLI→Host 反向请求的窄传输面（协议宿主注入 context.requestClient 的签名子集）。 */
export type ContinuousAgentWireRequest = <T>(
  method: string,
  params: unknown,
  resultSchema: z.ZodType<T>,
) => Promise<T>;

/** 执行适配器的窄视图：登记端口与模型/IO 共享的同一本地准入。 */
export interface ContinuousRegistrationAdapterView {
  waitForAdmission(
    ref: { cycleId: string; workflowRunId: string },
    signal?: AbortSignal,
  ): Promise<void>;
  inspectHealth(ref: {
    cycleId: string;
    executionSessionId: string;
    workflowRunId: string;
    traceId: string;
  }): Promise<{
    admissionState: "open" | "suspended" | "revoked";
  }>;
  suspendAtSafeBoundary(
    ref: { cycleId: string; executionSessionId: string; workflowRunId: string; traceId: string },
    reason: string,
  ): Promise<void>;
}

export interface ContinuousManagedRunStoreDeps {
  request: ContinuousAgentWireRequest;
  logger?: { warn?: (message: string, meta?: unknown) => void; info?: (message: string, meta?: unknown) => void };
  /** 隔离提供方工厂（缺省 darwin 自证 seatbelt；其它平台 verified=false → 测试 unverified）。 */
  createIsolation?: () => Promise<ContinuousIsolationProvider>;
}

interface ManagedRunRegistration {
  payload: ContinuousRegisterManagedRunCommand;
  io: ContinuousManagedIoRegistration;
  budgetGate: ReturnType<typeof createContinuousModelBudgetGate>;
  decisionGate: ReturnType<typeof createContinuousDecisionGate>;
}

export class ContinuousRegistrationError extends Error {
  constructor(
    readonly reason: "registration_invalid" | "capability_missing",
    message: string,
  ) {
    super(message);
    this.name = "ContinuousRegistrationError";
  }
}

/**
 * 登记处：runId → 该轮的预算/决策/IO 端口。一个 CLI 进程（单 workspace）一个实例；
 * create-app 的 continuousManagedCycles 注册函数从这里查，v4 登记命令往这里写。
 */
export function createContinuousManagedRunStore(deps: ContinuousManagedRunStoreDeps) {
  const registrations = new Map<string, ManagedRunRegistration>();
  let adapter: ContinuousRegistrationAdapterView | null = null;

  const bindExecutionAdapter = (view: ContinuousRegistrationAdapterView): void => {
    adapter = view;
  };

  const ioPolicyFor =
    (payload: ContinuousRegisterManagedRunCommand, grants: ReturnType<typeof createContinuousCandidateGrantHolder>) =>
    (role: ContinuousActorRole): ContinuousActorIoPolicy => ({
      role,
      config: (): ContinuousExecutionPolicyConfig => ({
        executionPath: payload.executionPath,
        workspacePath: payload.workspacePath,
        scope: payload.scope,
        declaredTestCommands: payload.declaredTestCommands,
        activeCandidate: grants.activeGrant(),
        pathStyle: platform === "win32" ? "win32" : "posix",
        caseInsensitiveFs: platform === "win32" || platform === "darwin",
        platformExecutionMode: assessContinuousPlatformExecution({
          platform,
          arch: process.arch,
        }).mode,
      }),
      waitForAdmission: (signal?: AbortSignal) => {
        if (adapter === null) return Promise.resolve();
        return adapter.waitForAdmission(
          { cycleId: payload.cycleId, workflowRunId: payload.workflowRunId },
          signal,
        );
      },
    });

  /** 应用一条登记：构造三类端口并登记；返回能力协商回音（含 interrupt）。 */
  const applyRegistration = async (
    payloadInput: unknown,
  ): Promise<{
    type: "continuousRegisterManagedRun";
    operations: string[];
    workflowRunId: string;
  }> => {
    // strict schema 在 wire 层已验；这里再 parse 一次是防御纵深（handler 直调路径）。
    const payload = payloadInput as ContinuousRegisterManagedRunCommand;
    if (
      !payload ||
      typeof payload.workflowRunId !== "string" ||
      payload.workflowRunId.length === 0
    ) {
      throw new ContinuousRegistrationError("registration_invalid", "登记载荷缺少 runId");
    }
    // 旧 epoch 拒绝：同 run 重复登记允许（恢复/继续前 Host 重发同轮冻结事实），但 leaseEpoch
    // 不得回退（§10 旧 epoch 不可写——高水位在执行适配器，登记侧至少拒绝 0 之外的回退）。
    const existing = registrations.get(payload.workflowRunId);
    if (existing && payload.leaseEpoch < existing.payload.leaseEpoch) {
      throw new ContinuousRegistrationError(
        "registration_invalid",
        `登记的 leaseEpoch ${payload.leaseEpoch} 低于已登记的 ${existing.payload.leaseEpoch}`,
      );
    }
    if (
      !Number.isSafeInteger(payload.requestCaps.inputTokenCap) ||
      payload.requestCaps.inputTokenCap <= 0 ||
      !Number.isSafeInteger(payload.requestCaps.outputTokenCap) ||
      payload.requestCaps.outputTokenCap <= 0
    ) {
      throw new ContinuousRegistrationError(
        "registration_invalid",
        "请求输入/输出上限必须为正整数（不能限制请求就不该自动执行，§9）",
      );
    }
    if (payload.pricing.prices.length === 0) {
      throw new ContinuousRegistrationError(
        "registration_invalid",
        "价格快照为空：费用限额下的自动执行必须拒绝（§9）",
      );
    }
    const grants = createContinuousCandidateGrantHolder();
    const wireDeps: ContinuousWireAgentPortDeps = {
      request: deps.request,
      getAdapter: () => adapter,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    };
    const ledger = wireLedger(wireDeps, payload);
    const builderRole = payload.builderRole ?? "builder";
    const actorPolicy = ioPolicyFor(payload, grants);
    // world 端口是模板骨架面：builder 角色 + 可信工具命令（提交/测试/浏览器证据）。
    const worldRole: ContinuousActorRole =
      payload.roles[builderRole] === "builder" ? "builder" : "observer";
    const outputRoot = payload.outputRoot ?? join(tmpdir(), "continuous-managed-outputs");
    await mkdir(outputRoot, { recursive: true });
    const testRunner = createContinuousConfinedTestRunner({
      executionPath: await realpath(payload.executionPath),
      outputRoot,
      isolation: await (deps.createIsolation?.() ?? createDarwinSeatbeltProvider({})),
    });
    const evidence = createContinuousEvidenceRegistry();
    const trusted = createContinuousTrustedPorts({
      policy: actorPolicy(worldRole),
      identity: () => ({
        programId: payload.programId,
        cycleId: payload.cycleId,
        runId: payload.workflowRunId,
        epoch: payload.leaseEpoch,
      }),
      baseCommit: () => payload.baseCommit,
      evidence,
      testRunner,
      // 浏览器证据提供方是 Host 装配的注入面（真实浏览器桥归 CT-15）；缺席时如实
      // unverified——不伪造通过（CT-11 已知限制 ④ 的产品形态）。
      grants,
      changeLimits: () => payload.changeLimits,
      suspendForChangeLimit: wireSuspendForChangeLimit(wireDeps, payload),
      outputRoot,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
    const budgetGate = createContinuousModelBudgetGate({
      programId: payload.programId,
      cycleId: payload.cycleId,
      ledger,
      pricing: payload.pricing,
      requestCaps: payload.requestCaps,
      maxAttemptsPerRequest: payload.maxAttemptsPerRequest,
      admissionProbe: (ref) => {
        if (adapter === null) return Promise.resolve({ admissionState: "open" });
        return adapter.inspectHealth({
          cycleId: ref.cycleId,
          executionSessionId: payload.executionSessionId,
          workflowRunId: payload.workflowRunId,
          traceId: payload.traceId,
        });
      },
      suspension: { waitForContinuation: wireSuspensionWait(wireDeps, payload) },
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });
    const decisionGate = createContinuousDecisionGate({
      programId: payload.programId,
      cycleId: payload.cycleId,
      sink: wireDecisionSink(wireDeps, payload),
      grants,
    });
    const io: ContinuousManagedIoRegistration = {
      executionPath: payload.executionPath,
      actorPolicyFor: (name: string | undefined) => {
        const role = name === undefined ? undefined : payload.roles[name];
        // 未知/未授权角色一律只读观察（不能根据模型输出决定角色，CT-12 登记）。
        return actorPolicy(role === undefined || role === null ? "observer" : role);
      },
      worldPolicy: actorPolicy(worldRole),
      trusted,
      testRunner,
    };
    registrations.set(payload.workflowRunId, {
      payload,
      io,
      budgetGate,
      decisionGate,
    });
    deps.logger?.info?.("Continuous managed run registered", {
      event: "continuous.registration.applied",
      module: "bootstrap.app",
      runId: payload.workflowRunId,
      cycleId: payload.cycleId,
      leaseEpoch: payload.leaseEpoch,
      maxConcurrentActors: payload.maxConcurrentActors,
    });
    return {
      // 能力协商回音：与 CONTINUOUS_CLI_MANAGED_OPERATIONS 同一份词表（含 interrupt）。
      operations: [
        "register",
        "submitOnce",
        "inspect",
        "resume",
        "stop",
        "interrupt",
        "waitForQuiescence",
        "readReports",
        "suspendAtSafeBoundary",
        "resumeSuspended",
        "inspectHealth",
      ],
      type: "continuousRegisterManagedRun" as const,
      workflowRunId: payload.workflowRunId,
    };
  };

  return {
    bindExecutionAdapter,
    applyRegistration,
    /** create-app 的 continuousManagedCycles 注册函数（缺登记返回 undefined → 守卫拒绝）。 */
    modelBudgetGateFor: (runId: string) => registrations.get(runId)?.budgetGate,
    decisionGateFor: (runId: string) => registrations.get(runId)?.decisionGate,
    executionPolicyFor: (runId: string) => registrations.get(runId)?.io,
    /** 冻结配置的并发上限（引擎 caps 用；不能退回 CPU 默认，CT-12）。 */
    maxConcurrentActorsFor: (runId: string): number | undefined =>
      registrations.get(runId)?.payload.maxConcurrentActors,
    dispose: (): void => {
      registrations.clear();
      adapter = null;
    },
  };
}

export type ContinuousManagedRunStore = ReturnType<typeof createContinuousManagedRunStore>;

/** 供 create-app 装配的 continuousManagedCycles 形状（enabled 由宿主策略面决定）。 */
export function continuousManagedCyclesOptionFor(
  store: ContinuousManagedRunStore,
): NonNullable<import("./types.js").ZCodeAppOptions["continuousManagedCycles"]> {
  return {
    enabled: true,
    modelBudgetGateFor: (runId) => store.modelBudgetGateFor(runId),
    decisionGateFor: (runId) => store.decisionGateFor(runId),
    executionPolicyFor: (runId) => store.executionPolicyFor(runId),
  };
}

/** 登记命令需要的执行端口窄视图（create-app 绑定适配器用）。 */
export function registrationAdapterViewOf(port: ContinuousExecutionPort & {
  waitForAdmission(ref: { cycleId: string }, signal?: AbortSignal): Promise<void>;
}): ContinuousRegistrationAdapterView {
  return {
    waitForAdmission: (ref, signal) => port.waitForAdmission(ref, signal),
    inspectHealth: (ref) => port.inspectHealth(ref),
    suspendAtSafeBoundary: (ref, reason) => port.suspendAtSafeBoundary(ref, reason),
  };
}
