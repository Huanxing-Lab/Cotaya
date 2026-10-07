// ContinuousProgramDetail（CT-08）：Program 详情整页（§12 必含项）。
// Status / Goal / Scope / Budget / Cadence / Health 与最近进展 / 继续确认 / Current Cycle /
// Latest Cycles / Improvement Queue / Decision Queue / Run now / Pause / 立即停止本轮 /
// 分支与提交交付位置。Pause（本轮结束后）与立即停止是两个动作，按钮与确认语分开（E-11）。
import { useState } from "react";
import {
  TID_CONTINUOUS_CYCLE_ROW,
  TID_CONTINUOUS_DETAIL,
  TID_CONTINUOUS_DETAIL_BACK,
  TID_CONTINUOUS_DETAIL_STATUS,
  TID_CONTINUOUS_PAUSE,
  TID_CONTINUOUS_RESUME,
  TID_CONTINUOUS_RUN_NOW,
  TID_CONTINUOUS_STOP_CURRENT,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { UseContinuousResult } from "@/hooks/useContinuous.js";
import {
  continuousCycleStatusLabel,
  continuousProgramStatusLabel,
} from "@/settings/continuous/continuousFormat.js";
import { DecisionQueue } from "@/settings/continuous/DecisionQueue.js";
import { ImprovementQueue } from "@/settings/continuous/ImprovementQueue.js";
import { ContinuationRequestDialog } from "@/settings/continuous/ContinuationRequestDialog.js";
import { ContinuousProgramFacts } from "@/settings/continuous/ContinuousProgramFacts.js";

/** Cycle 行 → 复用 WorkflowRunSidePane 的 Run 展示（onOpenRun 由 shell 层接线）。 */
export interface ContinuousOpenRunTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  cycleId: string;
  sequence: number;
  cycleStatus: string;
  programGoal: string;
  workflowRunId: string;
  executionSessionId: string;
}

export interface ContinuousProgramDetailProps {
  continuous: UseContinuousResult;
  onBack: () => void;
  onOpenRun?: (target: ContinuousOpenRunTarget) => void;
}

export function ContinuousProgramDetail({
  continuous,
  onBack,
  onOpenRun,
}: ContinuousProgramDetailProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [continuationOpen, setContinuationOpen] = useState(true);
  const detail = continuous.detail;

  if (!detail) {
    return (
      <div data-testid={TID_CONTINUOUS_DETAIL} className="flex flex-col">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <div className="mt-8 flex h-40 items-center justify-center">
          {continuous.detailError ? (
            <p role="alert" className="text-ui-base text-destructive">
              {intl.formatMessage({ id: "continuous.snapshot.error" })}：{continuous.detailError}
            </p>
          ) : (
            <Spinner className="size-5" />
          )}
        </div>
      </div>
    );
  }

  const program = detail.program;
  const currentCycle = detail.currentCycle;
  const canRun = program.status === "active" || program.status === "sleeping";
  const busy = continuous.busy !== null;

  const handleStopCurrent = async () => {
    if (!currentCycle) return;
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "continuous.stop.title" }),
      description: intl.formatMessage({ id: "continuous.stop.description" }),
      confirmLabel: intl.formatMessage({ id: "continuous.stop.confirm" }),
      confirmVariant: "destructive",
      showKeyboardHints: false,
    });
    if (!confirmed) return;
    // 立即停止必须带当前 lease epoch（detail 读面）；旧 epoch 会被服务端 lease_lost 拒绝。
    await continuous.stopCurrentCycle(
      program.programId,
      currentCycle.cycleId,
      detail.lease?.epoch ?? currentCycle.leaseEpoch,
    );
  };

  const openRunFor = (cycle: {
    cycleId: string;
    sequence: number;
    status: string;
    workflowRunId: string;
    executionSessionId: string;
  }) => {
    onOpenRun?.({
      workspacePath: program.workspacePath,
      ...(program.workspaceIdentity ? { workspaceIdentity: program.workspaceIdentity } : {}),
      cycleId: cycle.cycleId,
      sequence: cycle.sequence,
      cycleStatus: cycle.status,
      programGoal: program.goal,
      workflowRunId: cycle.workflowRunId,
      executionSessionId: cycle.executionSessionId,
    });
  };

  return (
    <div data-testid={TID_CONTINUOUS_DETAIL} className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={TID_CONTINUOUS_DETAIL_BACK}
          onClick={onBack}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <span
          data-testid={TID_CONTINUOUS_DETAIL_STATUS}
          className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle"
        >
          {continuousProgramStatusLabel(intl.formatMessage, program.status)}
        </span>
      </div>

      <header className="flex flex-col gap-1">
        <h1 className="text-wrap-phrase text-ui-lg font-medium leading-6 text-foreground">
          {program.goal}
        </h1>
        {program.statusReason ? (
          <p className="text-ui-base leading-5 text-foreground-subtle">{program.statusReason}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            data-testid={TID_CONTINUOUS_RUN_NOW}
            disabled={busy || !canRun}
            onClick={() => void continuous.runNow(program.programId)}
          >
            {continuous.busy === "runNow" ? <Spinner className="size-3.5" /> : null}
            {intl.formatMessage({ id: "continuous.action.runNow" })}
          </Button>
          {/* Pause：本轮结束后生效；与立即停止是两个命令（E-11）。 */}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid={TID_CONTINUOUS_PAUSE}
            disabled={busy || program.status === "paused"}
            onClick={() => void continuous.pauseProgram(program.programId)}
          >
            {intl.formatMessage({ id: "continuous.action.pause" })}
          </Button>
          {program.status === "paused" || program.status === "failed" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid={TID_CONTINUOUS_RESUME}
              disabled={busy}
              onClick={() => void continuous.resumeProgram(program.programId)}
            >
              {intl.formatMessage({ id: "continuous.action.resume" })}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            data-testid={TID_CONTINUOUS_STOP_CURRENT}
            disabled={busy || !currentCycle}
            onClick={() => void handleStopCurrent()}
          >
            {intl.formatMessage({ id: "continuous.action.stopCurrent" })}
          </Button>
        </div>
      </header>

      {continuous.commandFailure ? (
        <p role="alert" className="text-ui-base text-destructive">
          {intl.formatMessage({ id: "continuous.command.failed" })}（
          {continuous.commandFailure.code}）：{continuous.commandFailure.message}
        </p>
      ) : null}

      {detail.continuationRequest && detail.continuationRequest.status === "pending" ? (
        <ContinuationRequestDialog
          open={continuationOpen}
          request={detail.continuationRequest}
          currentCycle={currentCycle}
          detail={detail}
          busy={busy}
          onAnswer={(answer) => {
            const request = detail.continuationRequest;
            if (!request) return;
            setContinuationOpen(false);
            void continuous.resolveContinuation(
              program.programId,
              request.requestId,
              request.version,
              answer,
            );
          }}
        />
      ) : null}

      <ContinuousProgramFacts
        detail={detail}
        onOpenRun={currentCycle ? () => openRunFor(currentCycle) : undefined}
      />

      <section aria-labelledby="continuous-cycles-title" className="flex flex-col gap-3">
        <h2 id="continuous-cycles-title" className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "continuous.cycles.title" })}
        </h2>
        <ul className="flex flex-col gap-2">
          {detail.recentCycles.map((cycle) => (
            <li
              key={cycle.cycleId}
              data-testid={testId(TID_CONTINUOUS_CYCLE_ROW, cycle.cycleId)}
              className="flex flex-col gap-1 rounded-lg border border-card-border bg-background p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ui-base font-medium text-foreground">#{cycle.sequence}</span>
                <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                  {continuousCycleStatusLabel(intl.formatMessage, cycle.status)}
                </span>
                <span className="text-ui-sm text-foreground-subtle">{cycle.triggerKind}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!onOpenRun}
                  onClick={() => openRunFor(cycle)}
                >
                  {intl.formatMessage({ id: "continuous.currentCycle.openRun" })}
                </Button>
              </div>
              {cycle.summary ? (
                <p className="text-wrap-phrase text-ui-sm leading-5 text-foreground-subtle">
                  {cycle.summary}
                </p>
              ) : null}
              <p className="text-ui-sm leading-5 text-foreground-subtle">
                {intl.formatMessage(
                  { id: "continuous.cycles.changedFiles" },
                  { count: String(cycle.changedFiles.length) },
                )}
                {" · "}
                {intl.formatMessage(
                  { id: "continuous.cycles.commits" },
                  { count: String(cycle.commits.length) },
                )}
                {cycle.outcome ? ` · ${cycle.outcome}` : ""}
              </p>
              {cycle.commits.length > 0 ? (
                <p className="font-mono text-ui-sm leading-5 text-foreground-subtlest">
                  {cycle.commits.join(" ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <ImprovementQueue
        candidates={detail.candidates}
        onOpenCycleRun={
          onOpenRun
            ? (cycleId) => {
                // 候选 → 实施 Cycle 的 Run 入口：实施轮可能在最近窗口外（>10 轮），此时退化为
                // 不可打开——不编造 Run。
                const cycle = detail.recentCycles.find((row) => row.cycleId === cycleId);
                if (cycle) openRunFor(cycle);
              }
            : undefined
        }
      />
      <DecisionQueue
        decisions={detail.decisions}
        busy={busy}
        onResolve={(decision, optionId, text) =>
          void continuous.resolveDecision(
            program.programId,
            decision.decisionId,
            decision.version,
            optionId,
            text,
          )
        }
        onDismiss={(decision) =>
          void continuous.dismissDecision(program.programId, decision.decisionId, decision.version)
        }
      />
    </div>
  );
}
