// ContinuousProgramFacts（CT-08）：Program 详情的事实区（配置/用量 + 当前轮健康）。
// 从 ContinuousProgramDetail.tsx 拆出（oxlint max-lines 400）；纯展示，事实全部来自
// 服务 programDetail 快照——费用标“估算”、unknown 以“已保留”单列、并发同时显示平台实际能力。
import type { ContinuousProgramDetailResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  continuousCycleStatusLabel,
  continuousHealthLabel,
  describeContinuousCadence,
  describeContinuousUsage,
  formatContinuousDuration,
  formatContinuousTokens,
  formatContinuousUsdMicros,
} from "@/settings/continuous/continuousFormat.js";
import { TID_CONTINUOUS_OPEN_RUN } from "@zcode/shared";

export interface ContinuousProgramFactsProps {
  detail: ContinuousProgramDetailResult;
  onOpenRun?: () => void;
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-ui-sm text-foreground-subtle">{label}</dt>
      <dd className="text-ui-base leading-5 text-foreground">{value}</dd>
    </div>
  );
}

export function ContinuousProgramFacts({ detail, onOpenRun }: ContinuousProgramFactsProps) {
  const { intl, locale } = useZCodeIntl();
  const program = detail.program;
  const currentCycle = detail.currentCycle;
  const dailyUsage = describeContinuousUsage(detail.dailyUsage, locale);
  const cycleUsage = detail.cycleUsage ? describeContinuousUsage(detail.cycleUsage, locale) : null;
  return (
    <>
      <section aria-labelledby="continuous-facts-title" className="flex flex-col gap-3">
        <h2 id="continuous-facts-title" className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "continuous.facts.title" })}
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl border border-card-border bg-background p-3 sm:grid-cols-2 lg:grid-cols-3">
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.cadence" })}
            value={describeContinuousCadence(intl.formatMessage, program.cadence)}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.timeZone" })}
            value={program.timeZone}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.template" })}
            value={`${program.template.templateId}@${program.template.templateVersion}`}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.dailyBudget" })}
            value={
              program.budget.dailyCostUsdMicros === null
                ? intl.formatMessage({ id: "continuous.facts.unlimited" })
                : formatContinuousUsdMicros(program.budget.dailyCostUsdMicros, locale)
            }
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.dailyUsage" })}
            value={`${dailyUsage.settled} + ${dailyUsage.unsettled}（${intl.formatMessage({ id: "continuous.usage.unsettled" })}）`}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.cycleBudget" })}
            value={formatContinuousUsdMicros(program.budget.perCycleCostUsdMicros, locale)}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.cycleUsage" })}
            value={
              cycleUsage
                ? `${cycleUsage.settled} + ${cycleUsage.unsettled}`
                : intl.formatMessage({ id: "continuous.facts.noOpenCycle" })
            }
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.tokens" })}
            value={`${formatContinuousTokens(program.budget.perCycleTokens, locale)}（${intl.formatMessage({ id: "continuous.facts.estimated" })}）`}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.concurrency" })}
            value={`${program.budget.maxConcurrentActors} / ${detail.platformConcurrency}（${intl.formatMessage({ id: "continuous.facts.platformConcurrency" })}）`}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.activeLimit" })}
            value={formatContinuousDuration(program.budget.activeExecutionLimitMs)}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.scope" })}
            value={program.scope.allowedPaths.join(", ")}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.branch" })}
            value={program.branchName ?? "—"}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.executionPath" })}
            value={program.executionPath ?? "—"}
          />
          <FactRow
            label={intl.formatMessage({ id: "continuous.facts.failures" })}
            value={String(program.consecutiveFailures)}
          />
        </dl>
      </section>

      <section aria-labelledby="continuous-current-title" className="flex flex-col gap-3">
        <h2 id="continuous-current-title" className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "continuous.currentCycle.title" })}
        </h2>
        {currentCycle ? (
          <div className="flex flex-col gap-2 rounded-xl border border-card-border bg-background p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
                #{currentCycle.sequence} ·{" "}
                {continuousCycleStatusLabel(intl.formatMessage, currentCycle.status)}
              </span>
              <span className="text-ui-sm text-foreground-subtle">
                {continuousHealthLabel(intl.formatMessage, currentCycle.healthState)}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid={TID_CONTINUOUS_OPEN_RUN}
                disabled={!onOpenRun}
                onClick={() => onOpenRun?.()}
              >
                {intl.formatMessage({ id: "continuous.currentCycle.openRun" })}
              </Button>
            </div>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-ui-sm sm:grid-cols-2">
              <FactRow
                label={intl.formatMessage({ id: "continuous.currentCycle.active" })}
                value={formatContinuousDuration(currentCycle.activeDurationMs)}
              />
              <FactRow
                label={intl.formatMessage({ id: "continuous.currentCycle.blocked" })}
                value={formatContinuousDuration(currentCycle.normalBlockedDurationMs)}
              />
              <FactRow
                label={intl.formatMessage({ id: "continuous.currentCycle.lastProgress" })}
                value={
                  currentCycle.lastProgressAt === null
                    ? "—"
                    : new Date(currentCycle.lastProgressAt).toLocaleString(locale)
                }
              />
              <FactRow
                label={intl.formatMessage({ id: "continuous.currentCycle.lastProbe" })}
                value={
                  currentCycle.lastProbeAt === null
                    ? "—"
                    : new Date(currentCycle.lastProbeAt).toLocaleString(locale)
                }
              />
            </dl>
          </div>
        ) : (
          <div className="rounded-xl border border-card-border bg-background px-3 py-2 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "continuous.facts.noOpenCycle" })}
            {program.nextCycleAt !== null
              ? ` · ${intl.formatMessage(
                  { id: "continuous.card.nextCycle" },
                  {
                    when: new Date(program.nextCycleAt).toLocaleString(locale),
                    duration: formatContinuousDuration(program.nextCycleAt - Date.now()),
                  },
                )}`
              : ""}
          </div>
        )}
      </section>
    </>
  );
}
