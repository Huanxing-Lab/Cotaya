// ContinuousSection（CT-08）：Automations 页第三个 tab「Continuous」的主视图。
// 列表态（Program 卡）/ 创建授权整页 / 详情整页三态；数据与命令全部经 useContinuous
// （服务 snapshot 事件驱动）。可用性三分的展示：service_missing 由父层直接不渲染本组件；
// unsupported 在这里明确展示（E-24），不退回普通 prompt 执行。
import { useState, type ReactNode } from "react";
import {
  TID_CONTINUOUS_CREATE_OPEN,
  TID_CONTINUOUS_PLATFORM_READ_ONLY,
  TID_CONTINUOUS_PROGRAM_CARD,
  TID_CONTINUOUS_PROGRAM_LIST,
  TID_CONTINUOUS_SECTION,
  TID_CONTINUOUS_UNSUPPORTED,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useContinuous } from "@/hooks/useContinuous.js";
import { logger } from "@/logger.js";
import {
  continuousProgramStatusLabel,
  formatContinuousDuration,
} from "@/settings/continuous/continuousFormat.js";
import { ContinuousProgramForm } from "@/settings/continuous/ContinuousProgramForm.js";
import { ContinuousProgramDetail } from "@/settings/continuous/ContinuousProgramDetail.js";
import type { ContinuousOpenRunTarget } from "@/settings/continuous/ContinuousProgramDetail.js";

// Cycle → Run 侧栏的打开目标从详情组件再导出（AutomationsSection/WorkspaceShellLayout 的
// prop 类型引用它，避免深链到 detail 文件内部）。
export type { ContinuousOpenRunTarget };

export interface ContinuousSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 页头（标题切换 + 副标题），与定时任务/工作流两个 tab 同构。 */
  header?: ReactNode;
  /** Cycle 行 → 复用 Run 侧栏（WorkflowRunSidePane）展示。 */
  onOpenRun?: (target: ContinuousOpenRunTarget) => void;
}

type ContinuousView = { mode: "list" } | { mode: "create" } | { mode: "detail" };

export function ContinuousSection({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  header,
  onOpenRun,
}: ContinuousSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const continuous = useContinuous({ workspacePath, workspaceIdentity, remoteSessionId });
  const [view, setView] = useState<ContinuousView>({ mode: "list" });

  if (
    continuous.availability.status === "service_missing" ||
    continuous.availability.status === "disabled"
  ) {
    // 父层（AutomationsSection）在 service 缺席/功能未开启时已收窄 tab；这里兜底不渲染
    // 业务面（disabled 是关闭态 stub 的明确应答，一期未决 4 修复，与 service_missing 同为
    // 隐藏态——「未开启」不展示不支持解释面）。
    logger.debug("[continuous] service 缺席或功能未开启，tab 收起");
    return null;
  }

  const pageHeader = header ?? null;

  if (continuous.availability.status === "unsupported") {
    // E-24：旧 CLI/远程 workspace —— 明确不支持，不回退普通 prompt 或本地同名路径。
    return (
      <div data-testid={TID_CONTINUOUS_UNSUPPORTED} className={cn("flex flex-col")}>
        {pageHeader}
        <div className="mt-8 rounded-xl border border-card-border bg-background px-4 py-6 text-ui-base text-foreground-subtle">
          <p className="font-medium text-foreground">
            {intl.formatMessage({ id: "continuous.unsupported.title" })}
          </p>
          {remoteSessionId ? (
            <p className="mt-2 leading-5">
              {intl.formatMessage({ id: "continuous.unsupported.remote" })}
            </p>
          ) : null}
          <p className="mt-2 leading-5">
            {intl.formatMessage({ id: "continuous.unsupported.description" })}
          </p>
        </div>
      </div>
    );
  }

  if (!workspacePath) {
    return (
      <div data-testid={TID_CONTINUOUS_SECTION} className="flex flex-col">
        {pageHeader}
        <div className="mt-8 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "continuous.noWorkspace" })}
        </div>
      </div>
    );
  }

  if (view.mode === "create") {
    return (
      <ContinuousProgramForm
        templates={continuous.templates}
        busy={continuous.busy === "createProgram"}
        failure={
          continuous.commandFailure?.command === "createProgram" ? continuous.commandFailure : null
        }
        onBack={() => setView({ mode: "list" })}
        onSubmit={(draft) =>
          void continuous.createProgram(draft).then((created) => {
            if (created) setView({ mode: "list" });
          })
        }
      />
    );
  }

  if (view.mode === "detail" && continuous.detailProgramId) {
    return (
      <ContinuousProgramDetail
        continuous={continuous}
        onBack={() => {
          continuous.openDetail(null);
          setView({ mode: "list" });
        }}
        onOpenRun={onOpenRun}
      />
    );
  }

  const programs = continuous.snapshot?.programs ?? [];
  // CT-10（规格 §13/E-24）：observe_only 平台在列表页明确解释「只提供观察、不开放自动实施」，
  // 不用隐藏入口代替解释；观察读面（Program/队列/历史）照常可用。
  const platformObserveOnly =
    continuous.availability.status === "ready" &&
    continuous.availability.capability.platform?.mode === "observe_only";
  return (
    <div data-testid={TID_CONTINUOUS_SECTION} className="flex flex-col">
      {pageHeader}
      {platformObserveOnly ? (
        <div
          data-testid={TID_CONTINUOUS_PLATFORM_READ_ONLY}
          role="status"
          className="mt-3 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
        >
          <p className="font-medium text-foreground">
            {intl.formatMessage({ id: "continuous.platform.observeOnly.title" })}
          </p>
          <p className="mt-1 leading-5">
            {intl.formatMessage({ id: "continuous.platform.observeOnly.description" })}
          </p>
        </div>
      ) : null}
      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "continuous.list.title" })}
        </h2>
        <Button
          type="button"
          data-testid={TID_CONTINUOUS_CREATE_OPEN}
          disabled={continuous.busy !== null}
          onClick={() => setView({ mode: "create" })}
        >
          {intl.formatMessage({ id: "continuous.create.button" })}
        </Button>
      </div>

      {continuous.commandFailure ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-base text-foreground"
        >
          {intl.formatMessage({ id: "continuous.command.failed" })}（
          {continuous.commandFailure.code}）：{continuous.commandFailure.message}
        </div>
      ) : null}

      {continuous.snapshotError ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "continuous.snapshot.error" })}：{continuous.snapshotError}
        </div>
      ) : null}

      {continuous.snapshot === null && !continuous.snapshotError ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : programs.length === 0 ? (
        <div className="mt-3 flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4">
          <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
            {intl.formatMessage({ id: "continuous.empty.title" })}
          </p>
        </div>
      ) : (
        <div
          data-testid={TID_CONTINUOUS_PROGRAM_LIST}
          className="mt-3 grid grid-cols-1 gap-4 self-stretch lg:grid-cols-2"
        >
          {programs.map((program) => (
            <button
              key={program.programId}
              type="button"
              data-testid={testId(TID_CONTINUOUS_PROGRAM_CARD, program.programId)}
              aria-label={intl.formatMessage(
                { id: "continuous.card.openDetail" },
                { goal: program.goal },
              )}
              onClick={() => {
                continuous.openDetail(program.programId);
                setView({ mode: "detail" });
              }}
              className="group flex min-h-[132px] flex-col gap-2 rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ui-base font-medium leading-5 text-foreground">
                  {program.goal.trim().length > 0 ? program.goal : "—"}
                </span>
                {/* 状态用文字表达（E-22：不靠颜色区分状态） */}
                <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                  {continuousProgramStatusLabel(intl.formatMessage, program.status)}
                </span>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-base leading-5 text-foreground-subtle">
                {/* snapshot 摘要不含 cadence/scope（详情读面才有）；列表卡只放快照事实。 */}
                {program.currentCycleId ? (
                  <span>{intl.formatMessage({ id: "continuous.card.cycleOpen" })}</span>
                ) : program.nextCycleAt !== null ? (
                  <span>
                    {intl.formatMessage(
                      { id: "continuous.card.nextCycle" },
                      {
                        when: new Date(program.nextCycleAt).toLocaleString(locale),
                        duration: formatContinuousDuration(program.nextCycleAt - Date.now()),
                      },
                    )}
                  </span>
                ) : null}
                <span>
                  {intl.formatMessage(
                    { id: "continuous.card.pendingDecisions" },
                    { count: String(program.pendingDecisionCount) },
                  )}
                </span>
                {program.pendingContinuationRequestId ? (
                  <span className="rounded-md bg-surface px-1.5 py-0.5">
                    {intl.formatMessage({ id: "continuous.card.continuationPending" })}
                  </span>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
