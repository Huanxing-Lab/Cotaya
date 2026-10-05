// ============================================================
// Continuous 可信工具端口（CT-11 第 4/5 条）
// ============================================================
// 修复依据：docs/tickets/continuous-release-gaps.md CT-11——「测试退出码、输出、Git diff、
// 文件/行数和浏览器 390/1280 证据由工具端口产生并关联 candidate/run/epoch」「本地提交由
// 可信 workspace/提交端口执行，检查实际授权路径与三阶段验证结果。受管模板移除直接
// world.run git add/commit 路径；actor 无任意 Git 写能力」。
//
// 暴露面：受管模板的 world 骨架经保留命令名（continuous-test / continuous-diff /
// continuous-browser / continuous-commit）调用本端口；io-guards 只把这几个名字分派到
// 这里，其余命令仍走声明测试命令的受控执行或拒绝。actor 端口不经过本模块——actor
// 无法直接触发提交（无任意 Git 写能力）。
//
// 提交门（规格 §7 三阶段 + CT-11 第 4 条）：证据只采信工具端口产出（evidence registry
// 的 producedBy 检查）；模型报告里的 exitCode/passed 文本不构成授权。提交前复查工作区
// （只有候选授权路径内的改动才提交，无关改动保留并记录未验证）与单轮变更量（超限触发
// 同轮挂起回调——继续只增加本轮额度，规格 §6.1）。

import type { ExecutionResult } from "@zcode/contracts";
import type { ContinuousActorIoPolicy } from "./continuous-io-guards.js";
import {
  CONTINUOUS_CONFINED_DEFAULT_TIMEOUT_MS,
  type ContinuousConfinedTestRunner,
} from "./continuous-confined-execution.js";
import type { ContinuousEvidenceRegistry } from "./continuous-evidence.js";
import {
  continuousPathPrefixCovers,
  gitCommitPaths,
  gitCumulativeDiff,
  gitWorkspaceDiff,
} from "./continuous-trusted-git.js";
import { checkContinuousGitOperation } from "./continuous-execution-policy.js";
import type { ContinuousCandidateGrantHolder } from "./continuous-decision-adapter.js";

/** 保留命令名（受管模板专用命名空间；不得同时声明为测试命令可执行名）。 */
export const CONTINUOUS_TRUSTED_COMMANDS = [
  "continuous-test",
  "continuous-diff",
  "continuous-browser",
  "continuous-commit",
] as const;

/**
 * CT-14 浏览器验证的通信期限（默认 5 分钟）：验证提供方必须在该期限内返回证据；超时只
 * 能如实 unverified，不伪造通过/失败。期限同时是操作等待登记的真实期限（normal_wait
 * 证据的到期事实，docs/specs/continuous.md §10.1「长命令必须有声明的操作期限」）。
 */
export const CONTINUOUS_BROWSER_CHECK_DEADLINE_MS = 300_000;

export type ContinuousTrustedCommand = (typeof CONTINUOUS_TRUSTED_COMMANDS)[number];

/** 浏览器证据提供方（Host/测试组合注入；缺席 → unverified，不伪造证据）。 */
export interface ContinuousBrowserEvidencePort {
  check(input: { candidateKey: string; widths: number[]; executionPath: string }): Promise<{
    outcome: "passed" | "failed" | "unverified";
    assertions: Array<{ kind: string; detail: string }>;
    reason: string;
    artifacts?: string[];
  }>;
}

export interface ContinuousTrustedPortsDeps {
  policy: ContinuousActorIoPolicy;
  /** 当前执行身份（证据关联 candidate/run/epoch 的 run/epoch 来源）。 */
  identity(): { programId: string; cycleId: string; runId: string; epoch: number };
  /** 单轮起始 commit（变更量累计口径的基准）。 */
  baseCommit(): string | undefined;
  evidence: ContinuousEvidenceRegistry;
  testRunner: ContinuousConfinedTestRunner;
  browser?: ContinuousBrowserEvidencePort;
  grants: ContinuousCandidateGrantHolder;
  /** 单轮文件/行数上限（继续授权后 Host 重新登记会返回更大的本轮值）。 */
  changeLimits(): { maxFiles: number; maxChangedLines: number };
  /**
   * 达上限时的同轮挂起回调：装配方负责冻结准入并让 Host 保存暂停与继续确认
   *（规格 §6.1：暂停同轮，继续只增加本轮额度）。回调返回后本端口仍拒绝本次提交。
   */
  suspendForChangeLimit(detail: {
    kind: "file_limit" | "line_limit";
    projectedFiles: number;
    projectedChangedLines: number;
  }): Promise<void>;
  /** 输出根（受控执行的输出目录父级；浏览器 artifacts 建议同根）。 */
  outputRoot: string;
  /**
   * CT-14 操作等待登记：声明测试/浏览器验证等实际长操作开始时登记（owner/原因/开始
   * 时刻/真实期限），完成/取消后移除——normal_wait 证据的唯一登记路径。缺省不登记：
   * 等待不被承认，时间照计（fail closed，不能凭工具在跑豁免计时）。
   */
  registerOperationWait?(input: {
    ownerId: string;
    reason: string;
    startedAt: number;
    deadlineAt: number;
    signal?: AbortSignal;
  }): { complete(): void };
  /** 浏览器验证通信期限（缺省 5 分钟；超时如实 unverified）。 */
  browserDeadlineMs?: number;
  logger?: {
    warn?: (message: string, meta?: unknown) => void;
    info?: (message: string, meta?: unknown) => void;
  };
}

export interface ContinuousTrustedDispatch {
  /** 保留命令判定（io-guards 用）。 */
  isTrustedCommand(file: string): boolean;
  /** 分派入口：返回 WorldRunResult 形态（stdout 是 JSON 信封）；结构性故障直接 throw。 */
  run(
    command: { file: string; args?: string[] },
    options?: { signal?: AbortSignal },
  ): Promise<ExecutionResult>;
}

function envelope(payload: unknown, startedAt: number): ExecutionResult {
  const text = JSON.stringify(payload);
  const completedAt = new Date();
  return {
    status: "completed",
    exitCode: 0,
    stdout: { text, bytes: Buffer.byteLength(text, "utf8"), truncated: false },
    stderr: { text: "", bytes: 0, truncated: false },
    durationMs: completedAt.getTime() - startedAt,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(startedAt),
    completedAt,
  };
}

export function createContinuousTrustedPorts(
  deps: ContinuousTrustedPortsDeps,
): ContinuousTrustedDispatch {
  const configOf = () => deps.policy.config();
  const isTrustedCommand = (file: string): boolean =>
    (CONTINUOUS_TRUSTED_COMMANDS as readonly string[]).includes(file);

  /** 受控测试：argv 取自登记的声明测试命令（按 index），不经模板转述。 */
  const runDeclaredTest = async (
    candidateKey: string,
    indexInput: string,
    signal?: AbortSignal,
  ) => {
    await deps.policy.waitForAdmission(signal);
    const config = configOf();
    const index = Number.parseInt(indexInput, 10);
    if (!Number.isInteger(index) || index < 0 || index >= config.declaredTestCommands.length) {
      return { status: "refused" as const, reason: "test_command_not_declared" };
    }
    if (!deps.testRunner.available) {
      // 缺少可信隔离实现：如实返回不可用（模板据此上报 unverified，不降级直跑）。
      return { status: "unavailable" as const, reason: "confined_execution_not_supported" };
    }
    const argv = config.declaredTestCommands[index]!.argv;
    // CT-14 操作等待登记：受控执行有真实超时（runner 杀整棵进程树），期限即该超时；
    // 完成/取消/超时（finally）都是移除通知。缺登记接缝时fail closed——等待不被承认。
    const startedAt = Date.now();
    const wait = deps.registerOperationWait?.({
      ownerId: `test:${candidateKey}:${index}`,
      reason: `declared test: ${argv.join(" ")}`,
      startedAt,
      deadlineAt: startedAt + CONTINUOUS_CONFINED_DEFAULT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    let result;
    try {
      result = await deps.testRunner.run(argv, { signal });
    } finally {
      wait?.complete();
    }
    const identity = deps.identity();
    deps.evidence.recordTest({
      ...identity,
      candidateKey,
      argv,
      exitCode: result.exitCode ?? null,
      status: result.status,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      durationMs: result.durationMs,
      isolationKey: result.isolationKey,
    });
    return {
      status: "ok" as const,
      exitCode: result.exitCode ?? null,
      runStatus: result.status,
      argv,
      stdoutTail: result.stdoutTail.slice(-2048),
      stderrTail: result.stderrTail.slice(-2048),
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
      durationMs: result.durationMs,
      isolationKey: result.isolationKey,
      ...identity,
    };
  };

  /** Git diff 事实（工具端口产出）：当前工作区改动 + 相对起始 commit 的累计。 */
  const runDiff = async (candidateKey: string) => {
    await deps.policy.waitForAdmission();
    const config = configOf();
    const workspace = await gitWorkspaceDiff(config.executionPath);
    const base = deps.baseCommit();
    const cumulativeFromBase =
      base === undefined ? undefined : await gitCumulativeDiff(config.executionPath, base);
    const limits = deps.changeLimits();
    const cumulative = {
      files:
        cumulativeFromBase === undefined
          ? workspace.changedFiles.length
          : cumulativeFromBase.changedFiles.length,
      changedLines:
        cumulativeFromBase === undefined
          ? workspace.added + workspace.removed
          : cumulativeFromBase.added + cumulativeFromBase.removed,
    };
    const identity = deps.identity();
    // 候选作用域的 diff 事实：changedFiles 只登记落在当前候选授权路径内的文件
    //（其他候选的遗留改动归各自候选，提交门据此核对归属）；累计口径仍取全工作区
    //（变更量上限是单轮整体约束，规格 §2）。
    const grant = deps.grants.activeGrant();
    const scopedFiles =
      grant === null || grant.candidateId !== candidateKey
        ? []
        : workspace.changedFiles.filter((file) =>
            grant.targetPaths.some((prefix) => continuousPathPrefixCovers(prefix, file)),
          );
    const evidence = {
      changedFiles: scopedFiles,
      added: workspace.added,
      removed: workspace.removed,
      cumulative,
    };
    deps.evidence.recordDiff({ ...identity, candidateKey, ...evidence });
    // 单轮变更量上限（规格 §2/§6.1）：达到即挂起同轮——不是拒绝后继续跑，
    // 而是冻结新写入并交给继续确认（继续只增加本轮额度）。
    if (evidence.cumulative.files > limits.maxFiles) {
      await deps.suspendForChangeLimit({
        kind: "file_limit",
        projectedFiles: evidence.cumulative.files,
        projectedChangedLines: evidence.cumulative.changedLines,
      });
      return {
        status: "suspended" as const,
        reason: "file_limit",
        limit: limits,
        ...evidence,
        ...identity,
      };
    }
    if (evidence.cumulative.changedLines > limits.maxChangedLines) {
      await deps.suspendForChangeLimit({
        kind: "line_limit",
        projectedFiles: evidence.cumulative.files,
        projectedChangedLines: evidence.cumulative.changedLines,
      });
      return {
        status: "suspended" as const,
        reason: "line_limit",
        limit: limits,
        ...evidence,
        ...identity,
      };
    }
    return { status: "ok" as const, limit: limits, ...evidence, ...identity };
  };

  /** 浏览器验证（工具端口产出 390/1280 证据；提供方缺席如实 unverified）。 */
  const runBrowser = async (candidateKey: string, payload: { widths?: number[] } | undefined) => {
    await deps.policy.waitForAdmission();
    const config = configOf();
    const widths =
      Array.isArray(payload?.widths) && payload!.widths!.length > 0
        ? payload!.widths!
        : [390, 1280];
    if (deps.browser === undefined) {
      return {
        status: "ok" as const,
        outcome: "unverified" as const,
        widths,
        assertions: [],
        reason: "browser port unavailable",
        artifacts: [],
        ...deps.identity(),
      };
    }
    // CT-14：浏览器验证必须有可诊断的通信期限——超时不能永远占住节点，也不能伪造通过/
    // 失败；期限同时是操作等待登记的真实期限（§10.1「长命令必须有声明的操作期限」）。
    const deadlineMs = deps.browserDeadlineMs ?? CONTINUOUS_BROWSER_CHECK_DEADLINE_MS;
    const startedAt = Date.now();
    const wait = deps.registerOperationWait?.({
      ownerId: `browser:${candidateKey}`,
      reason: "browser validation",
      startedAt,
      deadlineAt: startedAt + deadlineMs,
    });
    let checked;
    try {
      const check = deps.browser.check({ candidateKey, widths, executionPath: config.executionPath });
      // 期限竞速落败后，提供方晚到的失败不算未处理拒绝（证据已按 unverified 落档）。
      check.catch(() => {});
      checked = await Promise.race([
        check,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`browser_check_deadline_exceeded:${deadlineMs}ms`));
          }, deadlineMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      // 期限超时（或提供方故障）：如实 unverified 并落证据，不伪造通过/失败。
      const reason =
        error instanceof Error ? error.message : "browser check failed without deadline";
      const identity = deps.identity();
      deps.evidence.recordBrowser({
        ...identity,
        candidateKey,
        outcome: "unverified",
        widths,
        assertions: [],
        reason,
        artifacts: [],
      });
      return {
        status: "ok" as const,
        outcome: "unverified" as const,
        widths,
        assertions: [],
        reason,
        artifacts: [],
        ...identity,
      };
    } finally {
      wait?.complete();
    }
    const identity = deps.identity();
    const artifacts = checked.artifacts ?? [];
    deps.evidence.recordBrowser({
      ...identity,
      candidateKey,
      outcome: checked.outcome,
      widths,
      assertions: checked.assertions,
      reason: checked.reason,
      artifacts,
    });
    return { status: "ok" as const, ...checked, widths, artifacts, ...identity };
  };

  /** 可信本地提交：授权 + 三阶段证据门 + 工作区复查 + 变更量上限。 */
  const runCommit = async (
    candidateKey: string,
    message: string,
    payload: { review?: { outcome?: string; findings?: string[] } } | undefined,
  ) => {
    await deps.policy.waitForAdmission();
    const config = configOf();
    const identity = deps.identity();
    // review 结论先落证据（reviewer 是只读 actor 的模型判断：作为否决面参与门，
    // 不单独构成授权——tests/browser 必须是工具端口事实）。
    const reviewOutcome = payload?.review?.outcome === "passed" ? "passed" : "failed";
    const findings = payload?.review?.findings ?? [];
    deps.evidence.recordReview({ ...identity, candidateKey, outcome: reviewOutcome, findings });
    const grant = deps.grants.activeGrant();
    if (grant === null || grant.candidateId !== candidateKey) {
      return {
        status: "refused" as const,
        reason: grant === null ? "candidate_inactive" : "candidate_mismatch",
      };
    }
    // 平台能力 + 角色纯策略复核（与 CT-02 同一判定函数；verification 先按证据门结论填）。
    const gate = deps.evidence.commitGate(candidateKey, identity.epoch, grant.targetPaths);
    if (!gate.ok) {
      return { status: "refused" as const, reason: gate.reason };
    }
    const decision = checkContinuousGitOperation(config, {
      role: "builder",
      operation: "commit",
      verification: { testsPassed: true, browserVerified: true, reviewPassed: true },
    });
    if (!decision.allowed) {
      return { status: "refused" as const, reason: decision.reason ?? "validation_required" };
    }
    // 提交前复查工作区：只提交候选授权路径内的实际改动；其余改动（其他候选的遗留、
    // 外部编辑）保留在工作区不提交也不清理（规格 §7「限制只改当前授权路径」与
    // CT-11「失败保留用户改动并记录未验证」；归属不明改动的恢复走候选检查点）。
    const workspace = await gitWorkspaceDiff(config.executionPath);
    const ownedChanges = workspace.changedFiles.filter((file) =>
      grant.targetPaths.some((prefix) => continuousPathPrefixCovers(prefix, file)),
    );
    if (ownedChanges.length === 0) {
      return { status: "refused" as const, reason: "nothing_to_commit" };
    }
    const commitResult = await gitCommitPaths(config.executionPath, message, ownedChanges, {
      name: "zcode-continuous",
      email: "continuous@zcode.local",
    });
    if (!commitResult.ok) {
      // 候选到达终局（提交失败）：释放占用，保留工作区改动（不清理不覆盖）。
      deps.grants.releaseActive();
      return { status: "refused" as const, reason: "git_commit_failed", error: commitResult.error };
    }
    deps.evidence.recordCommit({
      ...identity,
      candidateKey,
      commit: commitResult.commit,
      changedFiles: ownedChanges,
    });
    // 提交完成：该候选的写占用结束（非撤销），下一个候选可以被授权。
    deps.grants.releaseActive();
    deps.logger?.info?.("Continuous trusted commit created", {
      event: "continuous.trusted.commit",
      module: "bootstrap.app",
      candidateKey,
      commit: commitResult.commit,
      runId: identity.runId,
      epoch: identity.epoch,
    });
    return {
      status: "ok" as const,
      commit: commitResult.commit,
      changedFiles: ownedChanges,
      ...identity,
    };
  };

  return {
    isTrustedCommand,
    async run(command, options) {
      const startedAt = Date.now();
      if (!isTrustedCommand(command.file)) {
        throw new Error(`continuous trusted port: ${command.file} is not a trusted command`);
      }
      const args = command.args ?? [];
      const candidateKey = args[0];
      if (candidateKey === undefined || candidateKey.length === 0) {
        return envelope({ status: "refused", reason: "candidate_key_required" }, startedAt);
      }
      try {
        switch (command.file as ContinuousTrustedCommand) {
          case "continuous-test": {
            const result = await runDeclaredTest(candidateKey, args[1] ?? "0", options?.signal);
            return envelope(result, startedAt);
          }
          case "continuous-diff":
            return envelope(await runDiff(candidateKey), startedAt);
          case "continuous-browser": {
            const payload =
              args[1] === undefined ? undefined : (JSON.parse(args[1]) as { widths?: number[] });
            return envelope(await runBrowser(candidateKey, payload), startedAt);
          }
          case "continuous-commit": {
            const message = args[1];
            if (message === undefined || message.length === 0) {
              return envelope({ status: "refused", reason: "commit_message_required" }, startedAt);
            }
            const payload =
              args[2] === undefined
                ? undefined
                : (JSON.parse(args[2]) as { review?: { outcome?: string; findings?: string[] } });
            return envelope(await runCommit(candidateKey, message, payload), startedAt);
          }
          default:
            throw new Error("unreachable trusted command");
        }
      } catch (error) {
        // 结构化信封内如实回报 refused（可 catch 的业务面）；意外异常上抛由 run 层处理。
        if (error instanceof Error && error.message.startsWith("continuous scope_denied")) {
          return envelope(
            { status: "refused", reason: "scope_denied", error: error.message },
            startedAt,
          );
        }
        throw error;
      }
    },
  };
}

/** 浏览器证据记录的形状重导出（测试断言用）。 */
export type { ContinuousBrowserEvidence } from "./continuous-evidence.js";
