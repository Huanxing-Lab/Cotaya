// useContinuous（CT-08）：Continuous 服务在 renderer 的唯一消费入口。
//
// 状态所有权：服务 snapshot/programDetail 是唯一业务事实；本 hook 只缓存「最近一份快照」
// 与未提交草稿/命令 pending（optimistic 反馈），不建第二份接受队列——队列/账本/状态机
// 全部在 Host 侧服务里。手机（web-remote-replayable）经同一 accessor 消费同一 snapshot，
// 重连后的补状态由服务读面回答，renderer 不重放已接受命令。
//
// 可用性三分（E-24 与回滚位的判据）：
//   service_missing —— accessor 没有 continuousService（Host 未装配/功能默认关闭）→ tab 隐藏；
//   unsupported     —— 服务在但 capability 不支持（旧 CLI/远程）→ 页面明确展示不支持；
//   ready           —— 可以查询与操作。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CONTINUOUS_DEFAULT_BUDGET,
  CONTINUOUS_DEFAULT_CADENCE,
  resolveWorkspaceKey,
  supportsManagedCycles,
  type ContinuousCapabilityResult,
  type ContinuousContinuationAnswer,
  type ContinuousProgramDetailResult,
  type ContinuousSnapshotResult,
  type ContinuousTemplateRef,
} from "@zcode/shared";
import type { IContinuousServiceFacade } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** 命令在飞标记：同窗只允许一个同类命令（防重复点击把幂等键之外的路径打穿）。 */
export type ContinuousCommandName =
  | "createProgram"
  | "runNow"
  | "pauseProgram"
  | "resumeProgram"
  | "stopCurrentCycle"
  | "resolveDecision"
  | "dismissDecision"
  | "resolveContinuation"
  | "archiveProgram";

export interface ContinuousCommandFailure {
  command: ContinuousCommandName;
  code: string;
  message: string;
}

export type ContinuousAvailability =
  | { status: "service_missing" }
  | { status: "checking" }
  | { status: "unsupported" }
  | { status: "ready"; capability: ContinuousCapabilityResult };

export interface UseContinuousOptions {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 远程 workspace 的会话 id；透传给服务（第一版远程执行结构化拒绝，E-24）。 */
  remoteSessionId?: string;
}

export interface ContinuousProgramDraft {
  goal: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  dailyCostUsdMicros: number | null;
  budget: typeof CONTINUOUS_DEFAULT_BUDGET;
  cadence: typeof CONTINUOUS_DEFAULT_CADENCE;
  template: ContinuousTemplateRef;
}

function isContinuousCommandError(error: unknown): error is { code: string; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

export function useContinuous(options: UseContinuousOptions) {
  const { workspacePath, workspaceIdentity, remoteSessionId } = options;
  const services = useServices();
  const service: IContinuousServiceFacade | undefined = services.continuousService;

  const [availability, setAvailability] = useState<ContinuousAvailability>(() =>
    service ? { status: "checking" } : { status: "service_missing" },
  );
  const [snapshot, setSnapshot] = useState<ContinuousSnapshotResult | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContinuousProgramDetailResult | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailProgramId, setDetailProgramId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<ContinuousTemplateRef[]>([]);
  const [busy, setBusy] = useState<ContinuousCommandName | null>(null);
  const [commandFailure, setCommandFailure] = useState<ContinuousCommandFailure | null>(null);
  const refreshSeqRef = useRef(0);

  const context = useMemo(() => {
    if (!workspacePath) return null;
    return {
      workspacePath,
      ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      workspaceKey: resolveWorkspaceKey({
        workspacePath,
        ...(workspaceIdentity?.trim() ? { workspaceIdentity } : {}),
      }),
      traceId: crypto.randomUUID(),
    };
  }, [remoteSessionId, workspaceIdentity, workspacePath]);

  const refreshSnapshot = useCallback(async () => {
    if (!service || !context) return;
    const seq = (refreshSeqRef.current += 1);
    try {
      const next = await service.snapshot({ context });
      if (seq === refreshSeqRef.current) {
        setSnapshot(next);
        setSnapshotError(null);
      }
    } catch (error) {
      if (seq === refreshSeqRef.current) {
        setSnapshotError(error instanceof Error ? error.message : String(error));
      }
      logger.warn("[continuous] snapshot 读取失败", { message: String(error) });
    }
  }, [context, service]);

  const refreshDetail = useCallback(
    async (programId: string | null) => {
      if (!service || !context || !programId) {
        setDetail(null);
        setDetailError(null);
        return;
      }
      const seq = (refreshSeqRef.current += 1);
      try {
        const next = await service.programDetail({ context, programId });
        if (seq === refreshSeqRef.current) {
          setDetail(next);
          setDetailError(null);
        }
      } catch (error) {
        if (seq === refreshSeqRef.current) {
          setDetailError(error instanceof Error ? error.message : String(error));
        }
        logger.warn("[continuous] programDetail 读取失败", { message: String(error) });
      }
    },
    [context, service],
  );

  // capability 门：service 实例出现即查（一次）；不支持/失败都如实落 availability。
  useEffect(() => {
    if (!service) {
      setAvailability({ status: "service_missing" });
      return;
    }
    let disposed = false;
    try {
      const capability = service.capability();
      if (!disposed) {
        setAvailability(
          supportsManagedCycles(capability)
            ? { status: "ready", capability }
            : { status: "unsupported" },
        );
      }
    } catch (error) {
      logger.warn("[continuous] capability 查询失败", { message: String(error) });
      if (!disposed) setAvailability({ status: "unsupported" });
    }
    return () => {
      disposed = true;
    };
  }, [service]);

  // 模板目录：授权表单的数据源；读失败按空目录处理（表单展示不可用原因）。
  useEffect(() => {
    if (!service || !context || availability.status !== "ready") return;
    let disposed = false;
    void service
      .listTemplates({ context })
      .then((result) => {
        if (!disposed) setTemplates(result.templates);
      })
      .catch((error: unknown) => {
        logger.warn("[continuous] 模板目录读取失败", { message: String(error) });
      });
    return () => {
      disposed = true;
    };
  }, [availability.status, context, service]);

  // snapshot 轮询 = 服务事件驱动的读面（5s；命令完成后立即刷新一次）。
  useEffect(() => {
    if (availability.status !== "ready" || !context) return;
    void refreshSnapshot();
    const timer = setInterval(() => void refreshSnapshot(), 5_000);
    return () => clearInterval(timer);
  }, [availability.status, context, refreshSnapshot]);

  // 详情随选中 Program 轮询（同 snapshot 节奏；未选中不查）。
  useEffect(() => {
    if (availability.status !== "ready" || !detailProgramId) return;
    void refreshDetail(detailProgramId);
    const timer = setInterval(() => void refreshDetail(detailProgramId), 5_000);
    return () => clearInterval(timer);
  }, [availability.status, detailProgramId, refreshDetail]);

  const runCommand = useCallback(
    async <T>(
      command: ContinuousCommandName,
      invoke: (service: IContinuousServiceFacade) => Promise<T>,
    ): Promise<T | null> => {
      if (!service || !context) return null;
      setBusy(command);
      setCommandFailure(null);
      try {
        const result = await invoke(service);
        await Promise.all([refreshSnapshot(), refreshDetail(detailProgramId)]);
        return result;
      } catch (error) {
        // 结构化错误（ContinuousCommandError 经 RPC 序列化后是 {code,message} 平面对象）
        // 与未知错误分开：前者按 code 给可读反馈，后者保留原文。
        const failure = isContinuousCommandError(error)
          ? { command, code: error.code, message: error.message }
          : {
              command,
              code: "unknown",
              message: error instanceof Error ? error.message : String(error),
            };
        setCommandFailure(failure);
        logger.warn("[continuous] 命令失败", { command, code: failure.code });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [context, detailProgramId, refreshDetail, refreshSnapshot, service],
  );

  const createProgram = useCallback(
    (draft: ContinuousProgramDraft) =>
      runCommand("createProgram", (target) =>
        target.createProgram({
          context: { ...context!, traceId: crypto.randomUUID() },
          goal: draft.goal,
          scope: {
            allowedPaths: draft.allowedPaths,
            forbiddenPaths: draft.forbiddenPaths,
            // 规格默认禁止能力面：不可通过表单或“继续”确认关闭（§2/§6.1）。
            forbiddenCapabilities: [
              "backend_rewrite",
              "db_migration",
              "billing_auth",
              "deploy",
              "push",
              "merge",
            ],
          },
          budget: {
            ...draft.budget,
            ...(draft.dailyCostUsdMicros === null
              ? {}
              : { dailyCostUsdMicros: draft.dailyCostUsdMicros }),
          },
          cadence: draft.cadence,
          decisionPolicy: { unknownToDecision: true },
          template: draft.template,
        }),
      ),
    [context, runCommand],
  );

  const runNow = useCallback(
    (programId: string) =>
      runCommand("runNow", (target) =>
        target.runNow({
          context: { ...context!, traceId: crypto.randomUUID() },
          programId,
          requestId: crypto.randomUUID(),
        }),
      ),
    [context, runCommand],
  );

  const pauseProgram = useCallback(
    (programId: string) =>
      runCommand("pauseProgram", (target) =>
        target.pauseProgram({ context: { ...context!, traceId: crypto.randomUUID() }, programId }),
      ),
    [context, runCommand],
  );

  const resumeProgram = useCallback(
    (programId: string) =>
      runCommand("resumeProgram", (target) =>
        target.resumeProgram({ context: { ...context!, traceId: crypto.randomUUID() }, programId }),
      ),
    [context, runCommand],
  );

  /** 立即停止本轮：必须携带当前 lease epoch（detail 读面给出；旧 epoch 被 lease_lost 拒绝）。 */
  const stopCurrentCycle = useCallback(
    (programId: string, cycleId: string, epoch: number) =>
      runCommand("stopCurrentCycle", (target) =>
        target.stopCurrentCycle({
          context: { ...context!, traceId: crypto.randomUUID() },
          programId,
          cycleId,
          epoch,
          reason: "user_request",
        }),
      ),
    [context, runCommand],
  );

  const resolveDecision = useCallback(
    (programId: string, decisionId: string, version: number, optionId?: string, text?: string) =>
      runCommand("resolveDecision", (target) =>
        target.resolveDecision({
          context: { ...context!, traceId: crypto.randomUUID() },
          programId,
          decisionId,
          version,
          ...(optionId === undefined ? {} : { optionId }),
          ...(text === undefined || text.trim().length === 0 ? {} : { text: text.trim() }),
        }),
      ),
    [context, runCommand],
  );

  const dismissDecision = useCallback(
    (programId: string, decisionId: string, version: number) =>
      runCommand("dismissDecision", (target) =>
        target.dismissDecision({
          context: { ...context!, traceId: crypto.randomUUID() },
          programId,
          decisionId,
          version,
        }),
      ),
    [context, runCommand],
  );

  const resolveContinuation = useCallback(
    (programId: string, requestId: string, version: number, answer: ContinuousContinuationAnswer) =>
      runCommand("resolveContinuation", (target) =>
        target.resolveContinuation({
          context: { ...context!, traceId: crypto.randomUUID() },
          programId,
          requestId,
          version,
          answer,
        }),
      ),
    [context, runCommand],
  );

  const archiveProgram = useCallback(
    (programId: string) =>
      runCommand("archiveProgram", (target) =>
        target.archiveProgram({
          context: { ...context!, traceId: crypto.randomUUID() },
          programId,
        }),
      ),
    [context, runCommand],
  );

  const openDetail = useCallback(
    (programId: string | null) => {
      setDetailProgramId(programId);
      setDetail(null);
      setDetailError(null);
      void refreshDetail(programId);
    },
    [refreshDetail],
  );

  return {
    availability,
    snapshot,
    snapshotError,
    detail,
    detailError,
    detailProgramId,
    templates,
    busy,
    commandFailure,
    clearCommandFailure: () => setCommandFailure(null),
    refreshSnapshot,
    openDetail,
    createProgram,
    runNow,
    pauseProgram,
    resumeProgram,
    stopCurrentCycle,
    resolveDecision,
    dismissDecision,
    resolveContinuation,
    archiveProgram,
  };
}

export type UseContinuousResult = ReturnType<typeof useContinuous>;
